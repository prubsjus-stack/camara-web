"use strict";

const $ = (id) => document.getElementById(id);
const logEl = null;
const say = (m, c) => console.log(c ? `[ok] ${m}` : m);

let peer = null;
let dc = null;
const bitrate = new Bitrate();
let statsTimer = null;
let signal = null;
let failTimer = null;

const ICE_ES = {
  new: "preparando",
  checking: "buscando ruta directa…",
  connected: "conectado",
  completed: "conectado",
  disconnected: "se cortó",
  failed: "no se pudo",
  closed: "cerrado",
};

function alertBox(title, body) {
  $("alert-title").textContent = title;
  $("alert-body").textContent = body;
  $("alert").hidden = false;
}
const hideAlert = () => ($("alert").hidden = true);

function setNet(state, text) {
  setPill($("pill-net"), state, `conexión: ${text}`);
}

function setPlaceholder(title, sub) {
  $("ph-title").textContent = title;
  $("ph-sub").textContent = sub;
}

// Igual que el telefono, la PC reporta su estado para poder leer el log.
let iceTipos = [];
function report(que, extra = "") {
  try {
    signal?.send({ t: "report", data: `${que}${extra ? " | " + extra : ""}` });
  } catch (_) {}
}

function setLink(url) {
  $("link").value = url || "";
  $("link").disabled = !url;
  $("btn-copy").disabled = !url;
  if (!url) {
    $("qr").className = "qr wait";
    $("qr").textContent = "Esperando URL pública…";
  }
}

async function api(path) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${path}${sep}t=${encodeURIComponent(qs.get("t") || "")}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

function loadQr() {
  if (!$("link").value) return;
  const qr = $("qr");
  qr.className = "qr";
  qr.innerHTML = `<img src="/api/qr.svg?t=${encodeURIComponent(qs.get("t") || "")}" alt="QR del link" width="200" height="200">`;
}

function stopStream(reason) {
  if (statsTimer) clearInterval(statsTimer);
  if (failTimer) clearTimeout(failTimer);
  statsTimer = failTimer = null;
  if (peer) peer.close();
  peer = null;
  dc = null;
  $("video").srcObject = null;
  $("live").classList.remove("on");
  for (const b of ["btn-full", "btn-snap", "btn-flip", "btn-kick"]) $(b).disabled = true;
  for (const m of ["res", "fps", "kbps", "rtt", "codec"]) {
    $(`m-${m}`).textContent = "—";
    $(`m-${m}`).className = "na";
  }
  setNet("", "—");
  setPlaceholder("Esperando al teléfono", reason || "Mándale el link de la derecha y autoriza la cámara.");
}

function iceTypesText() {
  const counts = {};
  for (const t of iceTipos) counts[t] = (counts[t] || 0) + 1;
  return Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ");
}

function onIceFailed() {
  alertBox(
    "No se pudo conectar con el teléfono",
    `La cámara se autorizó y la negociación empezó, pero no se encontró ninguna ruta entre las dos redes. ` +
      `Candidatos descubiertos: ${iceTypesText() || "ninguno"}. ` +
      `Suele pasar con datos móviles: hace falta un relé TURN y los públicos están saturados. ` +
      `Prueba otra red (WiFi en vez de datos) o configura un TURN propio.`
  );
  setPlaceholder("Sin conexión", "No hay ruta entre tu PC y el teléfono. Ver aviso arriba.");
  setNet("err", "falló");
}

async function makeOffer() {
  if (peer) peer.close();
  iceTipos = [];
  hideAlert();
  setNet("warn", "negociando");

  peer = new Peer(window.__ice, (msg) => signal.signal(msg), {
    iceTransportPolicy: qs.get("relay") ? "relay" : null,
  });

  peer.pc.onicecandidate = ((original) => (ev) => {
    if (ev.candidate) {
      const m = /typ (\w+)/.exec(ev.candidate.candidate);
      if (m) {
        iceTipos.push(m[1]);
        report("ice-candidato", m[1]);
      }
    }
    original(ev);
  })(peer.pc.onicecandidate);

  peer.pc.oniceconnectionstatechange = () => {
    const s = peer.pc.iceConnectionState;
    report("ice", `${s} candidatos=${iceTipos.join("+") || "ninguno"}`);
    setNet(s === "connected" || s === "completed" ? "ok" : s === "failed" ? "err" : "warn", ICE_ES[s] || s);
    if (s === "failed") onIceFailed();
  };

  peer.pc.onconnectionstatechange = () => report("pc", peer.pc.connectionState);

  peer.pc.ondatachannel = (ev) => {
    dc = ev.channel;
    dc.onopen = () => say("canal de control abierto", "s");
  };

  peer.pc.ontrack = (ev) => {
    if (ev.track.kind !== "video") return;
    $("video").srcObject = ev.streams[0] || new MediaStream([ev.track]);
    setPlaceholder("Conectando…", "Estableciendo el flujo de video.");
    report("ontrack", `${ev.track.readyState} kind=${ev.track.kind}`);
    ev.track.addEventListener("ended", () => report("track-ended", "el receptor se corto"));
    ev.track.addEventListener("mute", () => report("track-mute", "sin datos"));
    for (const b of ["btn-full", "btn-snap", "btn-flip", "btn-kick"]) $(b).disabled = false;
    pollStats();
  };

  peer.pc.addTransceiver("video", { direction: "recvonly" });
  peer.pc.addTransceiver("audio", { direction: "recvonly" });
  peer.pc.createDataChannel("ctl");

  const offer = await peer.pc.createOffer();
  await peer.pc.setLocalDescription(offer);
  signal.signal({ kind: "offer", sdp: peer.pc.localDescription.toJSON() });
  say("oferta enviada");

  if (failTimer) clearTimeout(failTimer);
  failTimer = setTimeout(() => {
    if (peer && !["connected", "completed"].includes(peer.pc.iceConnectionState)) onIceFailed();
    else if (peer) report("timeout-40s", `estado=${peer.pc.iceConnectionState} pista=${$("video").videoWidth}px`);
  }, 40000);
}

function pollStats() {
  if (statsTimer) clearInterval(statsTimer);
  let announced = false;
  statsTimer = setInterval(async () => {
    if (!peer) return;
    const r = await readStats(peer.pc, "in");
    if (!r.w) return;
    if (!announced) {
      announced = true;
      $("live").classList.add("on");
      hideAlert();
            setPlaceholder("", "");
            if (failTimer) clearTimeout(failTimer);
            report("video-vivo", `${r.w}x${r.h} ${r.fps}fps ${r.codec} ruta=${r.path}`);
          }
    const kbps = bitrate.sample(r.bytes);
    const set = (id, val, ok = true) => {
      const el = $(`m-${id}`);
      el.textContent = val;
      el.className = ok ? "" : "na";
    };
    set("res", `${r.w}x${r.h}`);
    set("fps", r.fps);
    set("kbps", `${kbps.toFixed(0)} kbps`);
    set("rtt", r.rtt === null ? "—" : `${r.rtt} ms`, r.rtt !== null);
    set("codec", r.codec);
    setNet(r.path.startsWith("TURN") ? "warn" : "ok", r.path);
  }, 1000);
}

function start() {
  signal = new Signal("owner", qs.get("t") || "");
  window.addEventListener("beforeunload", () => signal.stop());

  signal.on("ready", async (msg) => {
    setPill($("pill-ws"), "ok", "señalización activa");
    window.__ice = msg.ice || [];
    try {
      const cfg = await api("/api/config");
      setLink(cfg.phoneLink);
      $("m-turn").textContent = cfg.turnCount || "ninguno";
      $("m-turn").className = cfg.turnCount ? "" : "na";
      if (!cfg.turnCount) {
        alertBox(
          "Sin relé TURN: solo funcionará en la misma red",
          "Con el teléfono en el mismo WiFi que la PC debería verse sin problema. " +
            "Pero con datos móviles el NAT de la operadora bloquea la entrada y no habrá imagen. " +
            "Para eso hace falta un TURN: revisa el apartado de seguridad del README (es gratis con Cloudflare)."
        );
      }
    } catch (err) {
      say(`config: ${err.message}`);
    }
  });

  signal.on("public-url", (msg) => {
    setLink(msg.url);
    loadQr();
  });

  signal.on("phone-joined", () => {
    setPlaceholder("Autorizando cámara…", "El teléfono tiene que darle permiso.");
    setNet("warn", "esperando teléfono");
    makeOffer();
  });

  signal.on("phone-left", () => {
    stopStream();
    hideAlert();
  });

  signal.on("signal", async (msg) => {
    const d = msg.data || {};
    if (!peer) {
      report("senal-sin-pc", d.kind || "?");
      return;
    }
    try {
      if (d.kind === "answer") {
        await peer.setRemote(d.sdp);
        report("respuesta-recibida", `${d.sdp && d.sdp.type}`);
      } else if (d.kind === "ice") {
        await peer.addIce(d.candidate);
      }
    } catch (err) {
      report("ERROR-en-senal", `${d.kind}: ${err.message}`);
    }
  });

  signal.on("error", (msg) => alertBox("Aviso del servidor", msg.msg || msg.code));

  signal.on("close", (msg) => {
    setPill($("pill-ws"), "err", `señalización caída (${msg.code})`);
  });

  setPill($("pill-ws"), "warn", "esperando token…");
  if (!qs.get("t")) {
    alertBox("Falta el token", "Abre la consola desde el link que imprimió el servidor, no desde la barra de direcciones.");
  }
}

$("btn-copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("link").value);
    $("btn-copy").textContent = "¡Copiado!";
    setTimeout(() => ($("btn-copy").textContent = "Copiar"), 1400);
  } catch (_) {
    $("link").select();
  }
};

$("btn-full").onclick = () =>
  document.fullscreenElement ? document.exitFullscreen() : $("box").requestFullscreen?.();

$("btn-snap").onclick = () => {
  const v = $("video");
  if (!v.videoWidth) return;
  const c = document.createElement("canvas");
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  const a = document.createElement("a");
  a.download = `captura-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  a.href = c.toDataURL("image/png");
  a.click();
};

$("btn-flip").onclick = () => dc?.readyState === "open" && dc.send(JSON.stringify({ t: "flip" }));
$("btn-kick").onclick = () => dc?.readyState === "open" && dc.send(JSON.stringify({ t: "stop" }));
$("qr-details").addEventListener("toggle", (e) => e.target.open && loadQr());

start();
