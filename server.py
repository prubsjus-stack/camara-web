"""Senalizacion WebRTC + hosting de las paginas, para el proyecto CamaraWeb.

La PC (dueno) corre este proceso. El telefono abre un link publico HTTPS,
autoriza la camara y el video viaja directo telefono -> PC por WebRTC.
Este archivo solo orchestra la negociacion (SDP/ICE); nunca toca el video.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from contextlib import suppress
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

import qrcode
import qrcode.image.svg
import websockets
from websockets.asyncio.server import ServerConnection
from websockets.protocol import State


def is_open(ws: ServerConnection | None) -> bool:
    return ws is not None and ws.state is State.OPEN

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
ICE_FILE = BASE_DIR / "ice.json"

OWNER = "owner"
PHONE = "phone"
ROLES = (OWNER, PHONE)

CF_TURN_API = "https://api.cloudflare.com/client/v4/accounts/{acct}/rtc/turn/keys/{key}/credentials/generate"

loop: asyncio.AbstractEventLoop | None = None
ice_servers: list[dict] = []


class Signaling:
    def __init__(self, tokens: dict[str, str]) -> None:
        self.tokens = tokens
        self.owner: ServerConnection | None = None
        self.phone: ServerConnection | None = None
        self.phone_name = ""
        self.public_url: str | None = None
        self.connected_at: float | None = None
        self.ice = ice_servers
        self.lock = asyncio.Lock()
        self.ice_log: list[str] = []
        self.phone_report = ""
        self.owner_report = ""
        self.frames = 0
        self.last_frame: float | None = None
        self.frame_info = ""

    def phone_link(self) -> str:
        if not self.public_url:
            return ""
        return f"{self.public_url.rstrip('/')}/phone.html?t={quote(self.tokens[PHONE])}"

    def owner_link(self) -> str:
        if not self.public_url:
            return ""
        return f"{self.public_url.rstrip('/')}/?t={quote(self.tokens[OWNER])}"

    async def send(self, target: str, payload: dict) -> None:
        sock = self.owner if target == OWNER else self.phone
        if sock is None:
            return
        with suppress(websockets.exceptions.ConnectionClosed, RuntimeError):
            await sock.send(json.dumps(payload))

    async def send_frame(self, data: bytes) -> None:
        """Envia un frame JPEG al dueno como binario, sin pasar por base64."""
        if self.owner is None:
            return
        with suppress(websockets.exceptions.ConnectionClosed, RuntimeError):
            await self.owner.send(data)

    async def notify_both(self, payload: dict) -> None:
        await self.send(OWNER, payload)
        await self.send(PHONE, payload)

    async def broadcast_public(self) -> None:
        await self.send(OWNER, {"t": "public-url", "url": self.public_url or ""})


room: Signaling | None = None


def guard(connection: ServerConnection, request) -> object | None:
    """Rechaza rol/token invalidos ANTES del handshake, con un 403 limpio.

    Cerrar despues del 101 es una carrera: el frame de cierre puede llegar
    pegado a la respuesta y algunos clientes lo ignoran.
    """
    assert room is not None
    query = parse_qs(urlparse(request.path).query)
    token = (query.get("t") or [""])[0]
    offered = [s.strip() for s in (request.headers.get("Sec-WebSocket-Protocol") or "").split(",")]
    role = next((r for r in ROLES if r in offered), "")
    if not role:
        return connection.respond(403, "rol desconocido")
    if not secrets.compare_digest(token, room.tokens[role]):
        return connection.respond(403, "token invalido")
    return None


async def handler(ws: ServerConnection) -> None:
    assert room is not None
    query = parse_qs(urlparse(ws.request.path).query)
    role = ws.subprotocol or ""
    token = (query.get("t") or [""])[0]

    if role not in ROLES:
        await ws.close(code=1008, reason="rol desconocido")
        return
    if not secrets.compare_digest(token, room.tokens[role]):
        await ws.close(code=1008, reason="token invalido")
        return

    name = (query.get("n") or ["Telefono"])[0][:40] or "Telefono"

    async with room.lock:
        if role == OWNER:
            room.owner = ws
        else:
            if is_open(room.phone):
                await ws.send(
                    json.dumps(
                        {
                            "t": "error",
                            "code": "busy",
                            "msg": "Ya hay un telefono transmitiendo. Cierra la otra pestana.",
                        }
                    )
                )
                await ws.close(code=1008, reason="ya hay un telefono")
                return
            room.phone = ws
            room.phone_name = name
            room.connected_at = time.time()

    await ws.send(json.dumps({"t": "ready", "role": role, "ice": room.ice}))

    if role == PHONE:
            await room.send(OWNER, {"t": "phone-joined", "name": name})
            print(f"[senal] telefono conectado desde {ws.remote_address}", flush=True)
    else:
        await room.send(PHONE, {"t": "owner-joined"})
        if is_open(room.phone):
            await ws.send(json.dumps({"t": "phone-joined", "name": room.phone_name}))

    try:
        async for raw in ws:
            if isinstance(raw, (bytes, bytearray)):
                # Frame JPEG del telefono, reenviado tal cual a la PC.
                if role == PHONE:
                    room.frames += 1
                    room.last_frame = time.time()
                    await room.send_frame(bytes(raw))
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = msg.get("t")
            if kind == "frame-info":
                room.frame_info = str(msg.get("data", ""))[:200]
                print(f"[frames] {msg.get('data')}", flush=True)
            elif kind == "signal":
                data = msg.get("data") or {}
                sub = data.get("kind", "?")
                if sub == "ice":
                    cand = data.get("candidate") or {}
                    tipo = (cand.get("candidate") or "").split("typ ")[-1].split(" ")[0]
                    room.ice_log.append(f"{role}:ice:{tipo}")
                else:
                    room.ice_log.append(f"{role}:{sub}")
                payload = {"t": "signal", "from": role, "data": data}
                await room.send(OWNER if role == PHONE else PHONE, payload)
            elif kind == "report":
                texto = str(msg.get("data", ""))[:600]
                if role == PHONE:
                    room.phone_report = texto
                    print(f"[telefono] {texto}", flush=True)
                else:
                    room.owner_report = texto
                    print(f"[dueno]    {texto}", flush=True)
            elif kind == "name":
                if role == PHONE:
                    room.phone_name = str(msg.get("name", ""))[:40]
                    await room.send(OWNER, {"t": "phone-joined", "name": room.phone_name})
            elif kind == "ping":
                await ws.send(json.dumps({"t": "pong"}))
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        async with room.lock:
            if role == OWNER and room.owner is ws:
                room.owner = None
            if role == PHONE and room.phone is ws:
                room.phone = None
                room.phone_name = ""
                room.connected_at = None
                await room.send(OWNER, {"t": "phone-left"})


def load_ice() -> list[dict]:
    if ICE_FILE.exists():
        try:
            data = json.loads(ICE_FILE.read_text(encoding="utf-8"))
            servers = data.get("iceServers", [])
            if isinstance(servers, list) and servers:
                return servers
        except (json.JSONDecodeError, OSError) as exc:
            print(f"[aviso] ice.json ilegible ({exc}); uso la config por defecto")
    return [
        {"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]},
        {
            "urls": [
                "stun:stun.cloudflare.com:3478",
                "stun:stun.nextcloud.com:443",
            ]
        },
    ]


def load_env_local() -> None:
    """Carga .env.local si existe, para no tener que exportar variables a mano."""
    archivo = BASE_DIR / ".env.local"
    if not archivo.is_file():
        return
    for linea in archivo.read_text(encoding="utf-8", errors="replace").splitlines():
        linea = linea.strip()
        if not linea or linea.startswith("#") or "=" not in linea:
            continue
        clave, valor = linea.split("=", 1)
        os.environ.setdefault(clave.strip(), valor.strip().strip('"').strip("'"))


def add_cloudflare_turn(servers: list[dict]) -> list[dict]:
    import os

    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    key_id = os.environ.get("CLOUDFLARE_TURN_KEY_ID", "")
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    if not (token and key_id and account):
        return servers

    url = CF_TURN_API.format(acct=account, key=key_id)
    request = urllib.request.Request(
        url,
        data=json.dumps({"ttl": 86400}).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            payload = json.load(response)
        creds = payload["result"]["credentials"]
        host = f"customer-{account}:turnkey-{key_id}@rtc.live.cloudflare.com"
        return [
            {
                "urls": [
                    f"turn:{host}:3478?transport=udp",
                    f"turns:{host}:5349?transport=tcp",
                ],
                "username": creds["username"],
                "credential": creds["credential"],
            },
            *servers,
        ]
    except (urllib.error.URLError, KeyError, json.JSONDecodeError, TimeoutError) as exc:
        print(f"[aviso] no se pudieron generar credenciales TURN de Cloudflare: {exc}")
        return servers


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "CamaraWeb/1.0"
    tokens: dict[str, str] = {}
    http_port = 0

    def log_message(self, fmt: str, *args) -> None:
        sys.stdout.write(f"  {self.address_string()} {fmt % args}\n")
        sys.stdout.flush()

    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        # Aislamiento de origen: habilita SharedArrayBuffer, que el telefono
        # necesita para marcar el ritmo de los frames con una espera real (sin
        # temporizadores, que el navegador frena en segundo plano). Todo lo que
        # carga la pagina es del mismo origen, asi que no rompe nada.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, payload: dict, code: int = 200) -> None:
        self._send(code, json.dumps(payload).encode(), "application/json; charset=utf-8")

    def _redirect(self, location: str) -> None:
        self._send(302, b"", "text/plain; charset=utf-8", {"Location": location})

    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/ws":
            self._websocket()
            return
        if path == "/":
            self._redirect(f"/index.html?t={quote(self.tokens[OWNER])}")
            return
        if path == "/favicon.ico":
            self._send(204, b"", "image/x-icon")
            return
        if path == "/phone":
            self._redirect(f"/phone.html?t={quote(self.tokens[PHONE])}")
            return
        if path == "/api/config":
            if not self._owner_token_ok(parsed):
                self._send(403, b"token de dueno invalido", "text/plain; charset=utf-8")
                return
            self._json(self._public_config())
            return
        if path == "/api/qr.svg":
            if not self._owner_token_ok(parsed):
                self._send(403, b"token de dueno invalido", "text/plain; charset=utf-8")
                return
            self._qr()
            return
        if path == "/api/status":
            assert room is not None
            self._json(
                {
                    "owner": is_open(room.owner),
                    "phone": is_open(room.phone),
                    "name": room.phone_name,
                    "uptime": round(time.time() - START, 1),
                    "traza": room.ice_log[-40:],
                    "telefonoDice": room.phone_report,
                    "pcDice": room.owner_report,
                    "frames": room.frames,
                    "frameInfo": room.frame_info,
                    "ultimoFrame": (
                        round(time.time() - room.last_frame, 1) if room.last_frame else None
                    ),
                }
            )
            return
        self._static(path)

    def _owner_token_ok(self, parsed) -> bool:
        token = (parse_qs(parsed.query).get("t") or [""])[0]
        return secrets.compare_digest(token, self.tokens[OWNER])

    def _public_config(self) -> dict:
        assert room is not None
        return {
            "phoneLink": room.phone_link(),
            "ownerLink": room.owner_link(),
            "ice": room.ice,
            "turnCount": sum(
                1 for s in room.ice for u in (s.get("urls") if isinstance(s.get("urls"), list) else [s.get("urls")]) if str(u).startswith(("turn:", "turns:"))
            ),
        }

    def _qr(self) -> None:
        assert room is not None
        link = room.phone_link()
        if not link:
            self._send(503, b"sin link publico todavia", "text/plain; charset=utf-8")
            return
        image = qrcode.make(link, image_factory=qrcode.image.svg.SvgPathImage, box_size=8, border=2)
        buffer = io.BytesIO()
        image.save(buffer)
        self._send(200, buffer.getvalue(), "image/svg+xml")

    def _static(self, path: str) -> None:
        rel = path.lstrip("/") or "index.html"
        target = (STATIC_DIR / rel).resolve()
        if not str(target).startswith(str(STATIC_DIR.resolve())) or not target.is_file():
            self._send(404, b"no encontrado", "text/plain; charset=utf-8")
            return
        types = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".svg": "image/svg+xml",
            ".json": "application/json; charset=utf-8",
        }
        ctype = types.get(target.suffix, "application/octet-stream")
        self._send(200, target.read_bytes(), ctype)

    def _websocket(self) -> None:
        assert room is not None
        if self.headers.get("Upgrade", "").lower() != "websocket":
            self._send(400, b"se esperaba websocket", "text/plain; charset=utf-8")
            return

        try:
            upstream = socket.create_connection(("127.0.0.1", WS_PORT), timeout=5)
            upstream.settimeout(None)
        except OSError as exc:
            self._send(502, f"senalizacion no disponible: {exc}".encode(), "text/plain; charset=utf-8")
            return

        lines = [
            f"GET {self.path} HTTP/1.1\r\n",
            f"Host: {self.headers.get('Host', '127.0.0.1')}\r\n",
            "Upgrade: websocket\r\n",
            "Connection: Upgrade\r\n",
            f"Sec-WebSocket-Key: {self.headers.get('Sec-WebSocket-Key', '')}\r\n",
            "Sec-WebSocket-Version: 13\r\n",
        ]
        proto = self.headers.get("Sec-WebSocket-Protocol", "")
        if proto:
            lines.append(f"Sec-WebSocket-Protocol: {proto}\r\n")
        upstream.sendall("".join(lines).encode("latin-1") + b"\r\n")

        self.close_connection = True
        stop = threading.Event()

        def pump_in() -> None:
            try:
                while not stop.is_set():
                    chunk = self.rfile.read1(65536)
                    if not chunk:
                        break
                    upstream.sendall(chunk)
            except (OSError, ValueError):
                pass
            finally:
                stop.set()
                with suppress(OSError):
                    upstream.shutdown(socket.SHUT_WR)

        threading.Thread(target=pump_in, daemon=True).start()
        try:
            while not stop.is_set():
                data = upstream.recv(65536)
                if not data:
                    break
                self.wfile.write(data)
                self.wfile.flush()
        except OSError:
            pass
        finally:
            stop.set()
            with suppress(OSError):
                upstream.close()


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def lan_addresses() -> list[str]:
    found: list[str] = []
    with suppress(OSError):
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        found.append(probe.getsockname()[0])
        probe.close()
    with suppress(OSError):
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127.") and ip not in found:
                found.append(ip)
    return found


def start_tunnel(public_url: str | None, http_port: int) -> None:
    assert room is not None
    if public_url:
        room.public_url = public_url.rstrip("/")
        return

    binary = BASE_DIR / "vendor" / "cloudflared.exe"
    if not binary.exists():
        print("[aviso] falta vendor\\cloudflared.exe -> el link publico no se habilita.")
        print("        ejecuta: powershell -ExecutionPolicy Bypass -File install-cloudflared.ps1")
        return

    command = [str(binary), "tunnel", "--url", f"http://127.0.0.1:{http_port}"]
    try:
        proc = subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except OSError as exc:
        print(f"[aviso] no se pudo iniciar cloudflared: {exc}")
        return

    pattern = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")

    def read_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            match = pattern.search(line)
            if match and room is not None and not room.public_url:
                room.public_url = match.group(0)
                print("\n[listo] link publico habilitado:")
                print(f"        {room.phone_link()}\n")
                if loop is not None:
                    asyncio.run_coroutine_threadsafe(room.broadcast_public(), loop)

    threading.Thread(target=read_stderr, daemon=True).start()


def banner(http_port: int) -> None:
    assert room is not None
    line = "=" * 66
    print(f"\n{line}")
    print("  CAMARA WEB  -  PC duena  -  telefono emisor")
    print(line)
    print(f"\n  [1] Consola del dueno (esta PC), ya abierta en el navegador:")
    print(f"      http://localhost:{http_port}/?t={room.tokens[OWNER]}")
    print(f"\n  [2] Link de acceso para el telefono:")
    if room.public_url:
        print(f"      {room.phone_link()}")
    else:
        print(f"      http://localhost:{http_port}/phone.html?t={room.tokens[PHONE]}")
        print("      (solo reachable desde esta PC: falta el tunel HTTPS publico)")
    print(f"\n  [3] El telefono autoriza la camara y la PC muestra el video.")
    print(f"\n  LAN (misma red, opcional):")
    for ip in lan_addresses():
        print(f"      http://{ip}:{http_port}/")
    print(f"\n  Servidor de senalizacion WebSocket: ws://127.0.0.1:{WS_PORT}/ws")
    print(f"  Ctrl+C para detener.\n{line}\n")


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Servidor de senalizacion WebRTC (dueno = PC).")
    ap.add_argument("--port", type=int, default=8770, help="puerto HTTP (default 8770)")
    ap.add_argument("--public-url", default=None, help="URL publica ya existente; omite el tunel")
    ap.add_argument("--no-tunnel", action="store_true", help="no iniciar cloudflared")
    ap.add_argument("--no-open", action="store_true", help="no abrir el navegador automaticamente")
    ap.add_argument("--owner-token", default=None, help="fija el token de la PC (link de demo estable)")
    ap.add_argument("--phone-token", default=None, help="fija el token del telefono (link de demo estable)")
    ap.add_argument(
        "--doctor",
        action="store_true",
        help="prueba los servidores STUN/TURN de ice.json y termina (no inicia el servidor)",
    )
    return ap.parse_args()


WS_PORT = 0
START = time.time()


def _stun_probe(host: str, port: int, udp: bool, timeout: float = 5.0) -> str:
    """Binding request minima. Devuelve 'ok', 'timeout' o el nombre del error."""
    import socket

    def pedir() -> bytes:
        attrs = struct.pack(">HH", 0x0020, 8) + os.urandom(8)
        return struct.pack(">HHI12s", 0x0001, len(attrs), 0x2112A442, os.urandom(12)) + attrs

    try:
        ip = socket.gethostbyname(host)
    except socket.gaierror:
        return "dns"
    try:
        if udp:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(timeout)
            s.connect((ip, port))
            s.send(pedir())
            data = s.recv(2048)
        else:
            s = socket.create_connection((ip, port), timeout=timeout)
            s.sendall(pedir())
            data = s.recv(2048)
        code = struct.unpack(">H", data[0:2])[0] if len(data) >= 4 else -1
        return "ok" if code in (0x0101, 0x0102) else f"err{code:#06x}"
    except socket.timeout:
        return "timeout"
    except OSError as exc:
        return exc.__class__.__name__


def _turn_allocate(url: str, username: str, credential: str) -> str:
    """Allocate TURN real (RFC 5766/6062). Devuelve 'ok' o el codigo de error."""
    import socket

    base = re.sub(r"^(turns?|stuns?):", "", url)
    base = base.split("?")[0]
    host, _, port = base.partition(":")
    port = int(port or 3478)
    udp = "transport=udp" in url or not url.startswith("turns:")

    def armar(con_integridad: bool) -> bytes:
        cuerpo = struct.pack(">HB", 0x0019, 4) + b"\x11\x00\x00\x00"
        if con_integridad:
            cuerpo += struct.pack(">HB", 0x0006, len(username)) + username.encode()
            cuerpo += struct.pack(">HB", 0x0014, len(realm)) + realm.encode()
            cuerpo += struct.pack(">HB", 0x0015, len(nonce)) + nonce.encode()
            if len(cuerpo) % 4:
                cuerpo += b"\x00" * (4 - len(cuerpo) % 4)
        cabecera = struct.pack(">HHI12s", 0x0003, len(cuerpo) + (24 if con_integridad else 0),
                                0x2112A442, os.urandom(12))
        if con_integridad:
            clave = hashlib.md5(f"{username}:{realm}:{credential}".encode()).digest()
            cuerpo += struct.pack(">HH", 0x0008, 20) + hmac.new(
                clave, cabecera + cuerpo + struct.pack(">I", 16 + len(cuerpo) + 4), hashlib.sha1).digest()
        return cabecera + cuerpo

    def attrs_de(data: bytes):
        if len(data) < 20:
            return []
        largo = struct.unpack(">H", data[2:4])[0]
        off, salida = 20, []
        while off + 4 <= min(len(data), 20 + largo):
            tipo, alto = struct.unpack(">HH", data[off:off + 4])
            salida.append((tipo, data[off + 4:off + 4 + alto]))
            off += 4 + alto
        return salida

    realm = nonce = ""
    try:
        if udp:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(6)
            s.connect((socket.gethostbyname(host), port))
            enviar = lambda m: s.send(m)
            recibir = lambda: s.recv(2048)
        else:
            s = socket.create_connection((socket.gethostbyname(host), port), timeout=6)
            s.settimeout(6)
            enviar = s.sendall
            recibir = lambda: s.recv(2048)
    except OSError as exc:
        return exc.__class__.__name__

    try:
        enviar(armar(False))
        r1 = recibir()
        for tipo, val in attrs_de(r1):
            if tipo == 0x0014:
                realm = val.decode(errors="replace")
            elif tipo == 0x0015:
                nonce = val.decode(errors="replace")
        if not realm or not nonce:
            return "sin-realm"
        enviar(armar(True))
        r2 = recibir()
        codigo = struct.unpack(">H", r2[0:2])[0] if len(r2) >= 4 else -1
        if codigo == 0x0003:
            return "ok"
        for tipo, val in attrs_de(r2):
            if tipo == 0x0009 and len(val) >= 4:
                return f"e{val[2]}"
        return f"tipo{codigo:#06x}"
    except (socket.timeout, TimeoutError):
        return "timeout"
    except OSError as exc:
        return exc.__class__.__name__
    finally:
        s.close()


def doctor(servers: list[dict]) -> int:
    """Comprueba cada servidor ICE y dice si la demo va a funcionar de verdad."""
    print("\n=== DIAGNOSTICO DE RED (server.py --doctor) ===\n")
    turno_ok: list[str] = []
    turno_malos: list[str] = []
    stun_ok = 0

    for server in servers:
        urls = server.get("urls")
        urls = urls if isinstance(urls, list) else [urls]
        for url in urls:
            limpio = re.sub(r"^(turns?|stuns?):", "", url).split("?")[0]
            host, _, puerto = limpio.partition(":")
            user, passwd = server.get("username", ""), server.get("credential", "")
            if url.startswith(("turn:", "turns:")):
                resultado = _turn_allocate(url, user, passwd)
                if resultado == "ok":
                    turno_ok.append(url)
                    print(f"  [ OK ] TURN  {url}")
                else:
                    turno_malos.append(f"{url} ({resultado})")
                    print(f"  [mal ] TURN  {url}  -> {resultado}")
            else:
                r = _stun_probe(host, int(puerto or 3478), "transport=udp" not in url)
                if r == "ok":
                    stun_ok += 1
                    print(f"  [ OK ] STUN  {url}")
                else:
                    print(f"  [mal ] STUN  {url}  -> {r}")

    print(f"\n  STUN operativos: {stun_ok}   TURN operativos: {len(turno_ok)}")
    if turno_malos:
        print("  TURN caidos: " + ", ".join(turno_malos))

    print()
    if not turno_ok:
        print("  SIN TURN: en la misma red funcionara, pero con datos moviles NO.")
        print("  El NAT movil no deja entrar la conexion y hace falta un rele.")
        print("  Monta uno gratis: https://dash.cloudflare.com > TURN > Create a TURN key")
        print("  y exporta CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_ACCOUNT_ID y CLOUDFLARE_API_TOKEN.")
    else:
        print("  LISTO: hay al menos un rele TURN, la demo funcionara con datos moviles.")
    print()
    return 0 if turno_ok else 1


def main() -> int:
    global loop, ice_servers, WS_PORT

    args = parse_args()
    if not STATIC_DIR.is_dir():
        print(f"[error] falta la carpeta {STATIC_DIR}")
        return 1

    load_env_local()
    ice_servers = add_cloudflare_turn(load_ice())

    if args.doctor:
        return doctor(ice_servers)

    tokens = {
        OWNER: args.owner_token or secrets.token_urlsafe(18),
        PHONE: args.phone_token or secrets.token_urlsafe(18),
    }

    global room
    room = Signaling(tokens)
    WS_PORT = free_port()

    Handler.tokens = tokens

    async def serve_forever() -> None:
        async with websockets.serve(
            handler, "127.0.0.1", WS_PORT, subprotocols=list(ROLES), process_request=guard
        ):
            await asyncio.Event().wait()

    def run_signaling() -> None:
        global loop
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(serve_forever())

    thread = threading.Thread(target=run_signaling, daemon=True)
    thread.start()

    for _ in range(100):
        with suppress(OSError):
            with socket.create_connection(("127.0.0.1", WS_PORT), timeout=0.2):
                break
        time.sleep(0.05)

    httpd = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    httpd.daemon_threads = True
    Handler.http_port = args.port

    if not args.no_tunnel:
        start_tunnel(args.public_url, args.port)
        time.sleep(3.0)

    if room.public_url and loop is not None:
        asyncio.run_coroutine_threadsafe(room.broadcast_public(), loop)

    banner(args.port)

    if not args.no_open:
        with suppress(Exception):
            webbrowser.open(f"http://localhost:{args.port}/?t={quote(tokens[OWNER])}")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  detenido.")
    finally:
        httpd.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
