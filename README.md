# CamaraWeb · la cámara del teléfono como cámara de la PC

Proyecto de universidad. La **PC es la dueña (owner)** y el **teléfono es el emisor**: al pulsar un
link de acceso, autorizar la cámara y nada más, el teléfono empieza a transmitir y el video aparece
directo en la pantalla de la PC.

No hace falta abrir la app de cámara del teléfono: el navegador toma la pista de video con
`getUserMedia()` y la envía por WebRTC.

```
   TELEFONO (emisor)                        PC (dueña)
   ┌──────────────────┐                    ┌────────────────────────┐
   │ phone.html       │                    │ server.py              │
   │ · getUserMedia   │                    │  · señalización WS     │
   │ · RTCPeerConn.   │                    │  · páginas + QR        │
   └────────┬─────────┘                    │  · túnel HTTPS         │
            │  1. abre el link HTTPS       │  · consola + preview   │
            ▼                               └───────────┬────────────┘
   ┌──────────────────┐   SDP/ICE (WebSocket)  ┌────────▼────────────┐
   │  cloudflared  ◄──┼───────────────────────►│  RTCPeerConnection   │
   │  (señalización)  │                        │  <video> en vivo     │
   └──────────────────┘                        └──────────▲───────────┘
            │                                              │
            │        2. video/audio P2P o vía TURN         │
            └──────────────────────────────────────────────┘
```

El **video nunca pasa por el servidor**: el túnel HTTP solo transporta la negociación (SDP/ICE).
Una vez conectado, el flujo va directo teléfono → PC, o a través de un relé TURN si la red lo impide.

---

## Requisitos

| Necesario | Para qué |
|---|---|
| Windows 10/11 con Python 3.10+ | ejecutar el servidor |
| `cloudflared` (se instala con un script) | exponer el link HTTPS público |
| Chrome o Edge en el teléfono | autorizar la cámara |
| Internet en ambos equipos | negociación y, si hace falta, relé |

## Instalación

```bash
cd C:\proyecto-camara-web
python -m pip install -r requirements.txt
powershell -ExecutionPolicy Bypass -File install-cloudflared.ps1
```

## Uso

```bash
python server.py
```

1. Se abre solo la **consola del dueño** en el navegador de la PC.
2. La consola muestra el **link de acceso** y su **QR**: mándalo al teléfono (WhatsApp, correo…)
   o escanéalo. También aparece en la terminal.
3. El teléfono abre el link, autoriza la cámara y empieza a transmitir.
4. El video aparece en la consola, con resolución, FPS, bitrate, codec y ruta de conexión en vivo.

En la consola del dueño puedes pedirle al teléfono que **cambie de cámara**, **desconectarlo**,
poner el video en **pantalla completa** o **guardar una imagen**.

Para terminar: que el teléfono pulse «Detener» o cierre la pestaña. Si la red cambia, la consola
detecta la caída y vuelve a buscar al teléfono automáticamente.

### Opciones

```bash
python server.py --port 8770            # puerto HTTP (por defecto 8770)
python server.py --no-tunnel            # solo local / LAN, sin cloudflared
python server.py --public-url https://tunel.midominio.com
python server.py --owner-token mi-clave --phone-token mi-clave   # link de demo estable
python server.py --no-open              # no abrir el navegador
```

O simplemente `start.bat`.

---

## Cómo funciona (lo que hay que explicar en la entrega)

### 1. Por qué hace falta HTTPS

Los navegadores solo entregan la cámara en un **contexto seguro**: `https://` o `localhost`.
Como el teléfono está en otra red, la página tiene que servirse por HTTPS. `cloudflared` levanta un
túnel con certificado válido y expone `http://localhost:8770` en una URL pública
`https://algo.trycloudflare.com`. El túnel es gratuito, no necesita cuenta ni dominio, y cambia de
URL cada vez que se arranca.

### 2. Por qué hace falta TURN

Los dos equipos están detrás de un NAT (el router de casa y la red móvil). STUN solo sirve para
descubrir la IP pública; no abre puertos. Si ambos NAT son simétricos —lo habitual en datos
móviles— la conexión directa falla y hace falta un **relé TURN** que reenvíe el tráfico.

`ice.json` trae STUN públicos (Google, Cloudflare) y tres relés TURN gratuitivos. La consola indica
en todo momento si la ruta es `directo` o `TURN (relé)`. Los relés gratuitos son compartidos y
pueden saturarse; para una demo exigente conviene un TURN propio (ver más abajo).

### 3. La negociación

El navegador no puede abrir un canal por su cuenta: los dos extremos deben intercambiar su
descripción de sesión (SDP) y sus candidatos ICE. Para eso está `server.py`, que solo reenvía
mensajes JSON por WebSocket:

```
teléfono ──phone-joined──► servidor ──phone-joined──► PC
PC       ──offer (SDP)───► servidor ──offer────────► teléfono
teléfono ──answer (SDP)──► servidor ──answer───────► PC
teléfono ──ice candidate─► servidor ──ice──────────► PC   (y al revés)
```

El WebRTC va **peer-to-peer**. Cuando el enlace está listo, los candidatos ICE que pueden llegar
antes que la SDP se guardan en cola y se aplican al recibirla (ver `Peer.addIce` en
`static/common.js`).

Además hay un `RTCDataChannel` de control: la PC puede pedirle al teléfono que cambie de cámara o
que detenga la transmisión, y el teléfono le manda información de la cámara que está usando.

### 4. Estructura

```
proyecto-camara-web/
├── server.py               servidor: páginas, señalización WebSocket, túnel y QR
├── install-cloudflared.ps1 descarga cloudflared en vendor/
├── start.bat               atajo para Windows
├── ice.json                servidores STUN/TURN configurables
├── requirements.txt
└── static/
    ├── index.html          consola del dueño (PC)
    ├── phone.html          emisor (teléfono)
    ├── common.js           WebSocket, PeerConnection, métricas
    ├── owner.js            lógica de la consola
    ├── phone.js            captura de cámara y publicación
    └── style.css
```

Todo el servidor cabe en un solo archivo y **las dos páginas comparten origen y puerto**, porque el
túnel solo expone una URL. Por eso `server.py` sirve también de proxy: si la petición es
`Upgrade: websocket` a `/ws`, la reenvía por TCP al servidor de señalización interno.

### 5. Seguridad

- Cada arranque genera dos tokens aleatorios (`secrets.token_urlsafe`). Sin el token correcto, el
  WebSocket se rechaza con **HTTP 403 antes del handshake** y los endpoints que exponen el link
  (`/api/config`, `/api/qr.svg`) también responden 403.
- Solo se acepta **un teléfono a la vez**; un segundo emisor recibe un mensaje de error explícito.
- El túnel sirve únicamente las dos páginas y la señalización. El video va por WebRTC.
- El link es *secreto pero efímero*: quien lo tenga puede transmitir. Para una demo pública conviene
  usar `--phone-token` con una clave elegida y revocarla al terminar.

---

## Configurar un TURN propio (opcional, recomendado para la demo)

Si los relés gratuitos fallan, crea una TURN key gratuita en
[dashboard.cloudflare.com → TURN → Keys](https://dash.cloudflare.com) y exporta:

```powershell
$env:CLOUDFLARE_API_TOKEN="tu token"
$env:CLOUDFLARE_ACCOUNT_ID="tu account id"
$env:CLOUDFLARE_TURN_KEY_ID="id de la TURN key"
python server.py
```

`server.py` pide credenciales temporales (24 h) a la API de Cloudflare y las añade al principio de
la lista ICE, con prioridad sobre los relés gratuitos.

## Extensiones posibles

- **Grabar en la PC**: `MediaRecorder` sobre el `MediaStream` recibido, o `ffmpeg` por WebRTC.
- **Varios espectadores**: hoy el dueño es único; se puede ampliar a N espectadores o emisores.
- **Reenviar a OBS/RTMP**: insertar `ffmpeg -i` con la URL SDP, o publicar la pista a un servidor RTMP.
- **Grabación en el teléfono**: `MediaRecorder` local si también quieres copia en el emisor.
- **App nativa**: envolver la misma lógica con Capacitor o WebView2.

## Pruebas realizadas

| Prueba | Resultado |
|---|---|
| Señalización: token inválido, rol inválido, segundo teléfono, reenvío de SDP/ICE, desconexión | 20/20 |
| E2E local en navegador (cámara falsa): video real, codec, bitrate, ruta ICE | OK |
| E2E realista: teléfono entrando por el HTTPS público + `wss` por el túnel | OK |

## Notas

- El video se negocia con **VP8** por defecto, que es lo que el navegador ofrece por defecto.
- En la consola, `ruta: directo` significa que no hubo relé; `TURN (relé)` que el tráfico se
  reenvió porque la conexión directa no era posible.
- Si el teléfono se ve espejado, es intencional (es la vista previa de una cámara frontal).
