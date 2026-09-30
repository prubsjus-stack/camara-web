# CamaraWeb · la cámara del teléfono como cámara de la PC

Proyecto de universidad. La **PC es la dueña (owner)** y el **teléfono es el emisor**: al pulsar un
link de acceso, autorizar la cámara y nada más, el teléfono empieza a transmitir y el video aparece
directo en la pantalla de la PC.

No hace falta abrir la app de cámara del teléfono: el navegador toma la pista de video con
`getUserMedia()` y la envía por WebRTC. La pestaña puede quedarse en segundo plano: cambiar de app
o bloquear la pantalla **no** corta la transmisión.

> **El teléfono puede estar en otra ciudad.** En ese caso el WebRTC directo no puede funcionar
> (las redes móviles no dejan abrir puertos entre sí) y el proyecto cambia de transporte solo:
> envía el video como imágenes JPEG por el mismo túnel HTTPS. No hace falta contratar nada ni
> configurar un TURN. Ver «Si el teléfono está en otra red».

```
   TELEFONO (emisor)                        PC (dueña)
   ┌──────────────────┐                    ┌────────────────────────┐
   │ phone.html       │                    │ server.py              │
   │ · getUserMedia   │                    │  · señalización WS     │
   │ · WebRTC o JPEG  │                    │  · páginas + QR        │
   └────────┬─────────┘                    │  · túnel HTTPS         │
            │  1. abre el link HTTPS       │  · reenvío de frames   │
            ▼                               └───────────┬────────────┘
   ┌──────────────────┐   SDP/ICE (WebSocket)  ┌────────▼────────────┐
   │  cloudflared  ◄──┼───────────────────────►│  RTCPeerConnection   │
   │  (señalización)  │                        │  <video> en vivo     │
   └──────────────────┘                        └──────────▲───────────┘
            │                                              │
            │   2a. video directo si las redes se dejan  │
            └──────────────────────────────────────────────┘
            │
            │   2b. o, si no hay ruta directa:            │
            │       JPEG por el mismo WebSocket ────────►│ <img> en vivo
            ▼
```

Hay dos rutas, y el teléfono elige la mejor sin que nadie toque nada:

| Ruta | Cuándo | Cómo viaja el video |
|---|---|---|
| **Directa (P2P)** | las dos redes se alcanzan (mismo WiFi, o alguna con TURN) | WebRTC directo, no pasa por el servidor |
| **Túnel** | redes aisladas: móvil 4G ↔ WiFi de la universidad | JPEG por el WebSocket del túnel |

En la ruta del túnel el video **sí pasa por el servidor** (a ~380 kbps), y por eso es más simple y
más lento, pero funciona en cualquier red sin depender de nadie.

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
2. La consola muestra el **link de acceso** en grande, con un botón «Copiar»: mándatelo al
   teléfono por WhatsApp, correo o el medio que quieras, y ábrelo allí. El **QR** está en un
   desplegable opcional, para cuando tengas el teléfono físicamente a mano.
3. El teléfono abre el link y **autoriza la cámara**: no hay más que hacer. Solo aparecen un
   indicador de estado y un botón «Detener».
4. El video aparece en la consola, con resolución, FPS, bitrate, codec y ruta de conexión en vivo.

En la consola del dueño puedes pedirle al teléfono que **cambie de cámara**, **desconectarlo**,
poner el video en **pantalla completa** o **guardar una imagen**.

Para terminar: que el teléfono pulse «Detener» o cierre la pestaña. Si el teléfono se bloquea o
pasa a segundo plano, **sigue transmitiendo**: el ritmo de captura no depende de temporizadores, que
es lo que los navegadores frenan cuando la app queda en segundo plano.

### Si el teléfono está en otra red

Es el caso previsto: el amigo está en su casa y tú presentas en la universidad. Las dos redes están
detrás de un NAT y los datos móviles no abren puertos entre sí, así que **el WebRTC directo no puede
funcionar**. No hace falta arreglarlo a mano: el teléfono lo detecta y cambia de ruta solo.

Qué pasa por dentro:

1. La PC manda su oferta WebRTC. La negociación ICE no encuentra candidato `relay` porque no hay
   ningún TURN configurado.
2. A los **7 segundos** —o en el acto si ICE pasa a `failed`— el teléfono activa el modo túnel.
3. A partir de ahí cada frame se dibuja en un `<canvas>` de 640 px de ancho, se codifica como JPEG
   y se manda por el WebSocket que ya estaba abierto para la señalización. El servidor lo reenvía a
   la PC, que lo pinta en un `<img>`.
4. La consola muestra `conexión: túnel seguro` y `codec: JPEG` para que quede claro que ya no va
   por WebRTC.

En la práctica son ~10 FPS a ~380 kbps: se ve con retraso, pero se ve, y no requiere cuentas ni
servicios de terceros.

**Detalles técnicos que importan** (medidos, no supuestos):

- El ritmo de captura usa un **worker con `Atomics.wait`**, no `setInterval`. Los navegadores
  ralentizan los temporizadores a ~0.5 FPS cuando la pestaña se oculta, y `Atomics.wait` es una
  espera real del hilo que no se ralentiza. Con el mismo diseño usando `MessageChannel` en bucle
  funcionaba igual, pero consumía el **92 % de un núcleo**; así baja al **7 %**, que es
  básicamente solo el coste de codificar el JPEG.
- El servidor envía `Cross-Origin-Opener-Policy` y `Cross-Origin-Embedder-Policy` para que la
  página quede aislada por origen y ese `SharedArrayBuffer` esté disponible. Si un navegador no lo
  permite, el proyecto cae a un bucle con `MessageChannel`: sigue funcionando, con más CPU.
- La codificación es **síncrona** (`toDataURL`). Con `toBlob`, que es asíncrono, el navegador
  aplazaba el envío con la pestaña oculta y el video se congelaba justo cuando tenía que seguir.

Si quieres probarlo sin esperar a que falle el WebRTC, añade parámetros al link del teléfono:

| Parámetro | Efecto |
|---|---|
| `?tunel=1` | fuerza el modo túnel e ignora el WebRTC |
| `?p2p=1` | desactiva el modo túnel (solo WebRTC directo) |
| `?relay=1` | limita ICE a `relay`, que sin TURN siempre falla: sirve para probar el cambio automático |

### Opciones de los links

```bash
python server.py --port 8770            # puerto HTTP (por defecto 8770)
python server.py --no-tunnel            # solo local / LAN, sin cloudflared
python server.py --public-url https://tunel.midominio.com
python server.py --owner-token mi-clave --phone-token mi-clave   # link de demo estable
python server.py --no-open              # no abrir el navegador
python server.py --doctor               # prueba STUN/TURN reales y sale
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

### 2. Por qué hace falta TURN… y por qué aquí no es obligatorio

Los dos equipos están detrás de un NAT (el router de casa y la red móvil). STUN solo sirve para
descubrir la IP pública; no abre puertos. Si ambos NAT son simétricos —lo habitual en datos
móviles— la conexión directa falla y haría falta un **relé TURN** que reenvíe el tráfico.

Los TURN públicos gratuitos que se probaron **no funcionan**: se les mandó una petición `Allocate`
real (RFC 5766) y ninguno concedió la asignación. Por eso `ice.json` hoy trae **solo STUN**:

| Servidor | Estado | Nota |
| --- | --- | --- |
| `stun.cloudflare.com:3478` | `[ OK ]` ~12 ms | el más rápido, se usa primero |
| `stun.voipbuster.com:3478` | `[ OK ]` | respaldo |
| `stun.sipnet.ru:3478` | `[ OK ]` | respaldo |
| `openrelay.metered.ca:80/443` | **muerto** | acepta la conexión y la cierra sin responder |
| `relay.metered.ca:80` | **muerto** | timeout |
| `stun.metered.ca:80` | **muerto** | timeout |

`python server.py --doctor` repite esa comprobación en cualquier momento y hoy dice
`3 STUN OK, 0 TURN`.

Ese hueco es exactamente lo que cubre el **modo túnel**: como el WebRTC directo no tiene un TURN que
lo respalde, el video viaja como JPEG por el túnel que ya está montado. Así que para la demo entre
ciudades **no hace falta contratar un TURN ni tener cuenta en ningún sitio**. Un TURN propio sigue
siendo la opción mejor si se quiere calidad nativa (VP8/H.264, menos retraso, menos carga), y por
eso existe `configurar-turn.ps1` (ver más abajo), pero ya no es un requisito para que funcione.

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
├── server.py               servidor: páginas, señalización WebSocket, túnel, QR y reenvío de frames
├── install-cloudflared.ps1 descarga cloudflared en vendor/
├── configurar-turn.ps1     TURN propio de Cloudflare (opcional, ya no necesario)
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
- El túnel sirve únicamente las dos páginas, la señalización y —en modo túnel— los frames de video.
  El WebRTC va directo teléfono → PC.
- El link es *secreto pero efímero*: quien lo tenga puede transmitir. Para una demo pública conviene
  usar `--phone-token` con una clave elegida y revocarla al terminar.

---

## Configurar un TURN propio (opcional, mejora la calidad)

Hace falta solo si quieres video nativo entre redes: menos retraso, menos carga y el codec del
navegador en vez de JPEG. El modo túnel ya cubre el caso de la demo sin esto.

Los TURN públicos gratuitos **están muertos**. Se comprobó uno por uno con un `Allocate` TURN real
(RFC 5766) contra `openrelay.metered.ca:80/443`, `relay.metered.ca:80` y `stun.metered.ca:80`:
`openrelay.metered.ca:443` acepta la conexión y la cierra sin responder, y los demás dan timeout.
Por eso `ice.json` ya no lista ninguno: es preferible un vacío honesto a cinco entradas que
nunca conectan.

La solución es una TURN key de Cloudflare, que es gratuita. El script lo hace todo:

```powershell
powershell -ExecutionPolicy Bypass -File configurar-turn.ps1
```

Pide tres datos (y al terminar ejecuta `--doctor` para confirmar):

1. **Key ID** — en [dashboard.cloudflare.com → TURN → Create a TURN key](https://dash.cloudflare.com).
2. **Account ID** — en la misma pantalla, arriba a la derecha.
3. **API Token** — en *API Tokens → Create Token*, con permiso **TURN: Edit**.

Los guarda en `.env.local` (ignorado por git), así que no hay que exportar nada a mano después.
`server.py` pide credenciales temporales (24 h) a la API de Cloudflare y las antepone a la lista
ICE, con prioridad sobre todo lo demás.

Para comprobar en cualquier momento que el relé responde de verdad:

```bash
python server.py --doctor
```

Ese comando habla TURN con cada servidor configurado y dice `[ OK ]` o el código de error
concreto (`401` credenciales, `timeout`, `ConnectionResetError`…). Es el primer sitio donde mirar
si la demo va a fallar.

## Extensiones posibles

- **Grabar en la PC**: `MediaRecorder` sobre el `MediaStream` recibido, o `ffmpeg` por WebRTC.
- **Varios espectadores**: hoy el dueño es único; se puede ampliar a N espectadores o emisores.
- **Reenviar a OBS/RTMP**: insertar `ffmpeg -i` con la URL SDP, o publicar la pista a un servidor RTMP.
- **Grabación en el teléfono**: `MediaRecorder` local si también quieres copia en el emisor.
- **App nativa**: envolver la misma lógica con Capacitor o WebView2.

## Pruebas realizadas

| Prueba | Resultado |
|---|---|
| Señalización: token inválido, rol inválido, segundo teléfono, reenvío de SDP/ICE, desconexión | TODO OK |
| E2E directo: teléfono por el HTTPS público + `wss` por el túnel, video real, codec, bitrate, ruta ICE | E2E PUBLICO OK |
| E2E túnel: sin ruta directa, frames JPEG llegando a la PC y **contenido que cambia** | TUNEL OK |
| Cambio automático a túnel: con ICE limitado a `relay` el teléfono cambia solo y sigue enviando | TUNEL OK |
| **Segundo plano**: con la pestaña oculta, ~10 FPS en la PC, cámara viva, CPU del 7 % | SEGUNDO PLANO OK |
| STUN/TURN reales (`--doctor`) | 3 STUN OK, 0 TURN (los públicos están muertos) |

Las pruebas de E2E no se quedan en «la página cargó»: leen píxeles del `<canvas>` en dos instantes
distintos y comparan, para confirmar que lo que se ve es video en movimiento y no una foto fija. Eso
fue justo lo que destapó un bug del panel que tapaba el video, y después un congelamiento en segundo
plano que no se veía en las pruebas simples.

## Notas

- El video se negocia con **VP8** por defecto, que es lo que el navegador ofrece por defecto.
- En la consola, `ruta: directo` significa video WebRTC sin relé; `TURN (relé)` que el tráfico se
  reenvió porque la conexión directa no era posible; `túnel seguro` que va como JPEG por el WebSocket.
- Si el teléfono se ve espejado, es intencional (es la vista previa de una cámara frontal).
