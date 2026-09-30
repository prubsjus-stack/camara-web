"use strict";

const $ = (id) => document.getElementById(id);

let signal = null;
let peer = null;
let dc = null;
let localStream = null;
let videoSender = null;
let watchdog = null;

// El telefono no tiene consola a la vista, asi que reporta su estado al
// servidor. Asi se puede leer desde la PC que esta pasando en el movil.
function report(que, extra = "") {
  try {
    signal?.send({ t: "report", data: `${que}${extra ? " | " + extra : ""}` });
  } catch (_) {}
}

function ui(dot, main, sub, show) {
  $("dot").className = `dot-big ${dot}`;
  $("msg-main").textContent = main;
  $("msg-sub").textContent = sub;
  $("btn-start").style.display = show || "none";
  $("btn-stop").style.display = show === false ? "block" : "none";
}

function reset(msg) {
  if (watchdog) clearTimeout(watchdog);
  watchdog = null;
  desactivarTunel();
  if (peer) peer.close();
  peer = null;
  dc = null;
  videoSender = null;
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  $("video").srcObject = null;
  $("video").classList.remove("on");
  ui("", msg || "Listo para empezar", "Toca el botón y permite el uso de la cámara", true);
  $("btn-start").disabled = false;
}

let lastCamError = "";

async function openCamera() {
  ui("", "Permitiendo la cámara…", "Confirma el permiso que aparece abajo", false);
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    lastCamError = "";
  } catch (err) {
    lastCamError = `${err.name}: ${err.message}`;
    reset("No se pudo abrir la cámara");
    $("msg-sub").textContent =
      err.name === "NotAllowedError"
        ? "Denegaste el permiso. Toca el candado de la barra de direcciones y permite la cámara."
        : `Error de cámara (${err.name}). Prueba con Chrome o Firefox.`;
    return false;
  }
  $("video").srcObject = localStream;
  $("video").classList.add("on");
  localStream.getVideoTracks()[0].addEventListener("ended", () => reset("Cámara desactivada"));
  return true;
}

function bindControl(channel) {
  dc = channel;
  dc.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === "flip") flipCamera();
    if (m.t === "stop") reset("La PC detuvo la transmisión");
  };
}

function iceTipos() {
  if (!peer) return "sin-pc";
  return (peer.tiposIce || []).join("+") || "ninguno";
}

// ------------------------------------------------------------------
// Modo tunel: el video viaja como JPEG por el mismo WebSocket que ya
// funciona a traves de cloudflared. No necesita TURN ni ruta directa, asi
// que funciona desde cualquier red y desde cualquier ciudad. Es mas lento
// que WebRTC, pero es el unico camino que no depende de terceros.
// ------------------------------------------------------------------
let tunnel = {
  activo: false, capturando: false, puerto: null, emisor: null, timer: null, rafId: null,
  trabajador: null, ctl: null,
  canvas: null, ctx: null, enviado: false, ultimo: 0, cuenta: 0,
  vueltas: 0, motivo: "sin iniciar", msMedio: 0, historia: [], aguante_hasta: 0,
};
window.tunnel = tunnel;

// Medido en este proyecto codificando imagen real de 1280x720 (ms por frame,
// y lo que cuesta eso a 11 FPS en un solo hilo):
//   640x360 q0.55 -> 39.0 ms -> 43% de CPU -> ~380 kbps
//   480x272 q0.50 -> 19.6 ms -> 22% de CPU -> ~240 kbps
//   320x180 q0.50 -> 13.3 ms -> 15% de CPU -> ~160 kbps
// 480x270 es el punto razonable: por debajo la imagen se ve demasiado borrosa
// en un proyector, y por arriba el telefono se calienta y se come la bateria
// en mitad de la presentacion. Si la red permite WebRTC, el video va a 720p
// nativo por el camino bueno y esto ni se usa.
const TUNEL_ANCHO = 480;
const TUNEL_CALIDAD = 0.5;
const TUNEL_FPS = 10;

function pintarEnCanvas() {
  if (!tunnel.canvas) {
    const v = $("video");
    const escala = Math.min(1, TUNEL_ANCHO / Math.max(v.videoWidth || 640, v.videoHeight || 480));
    tunnel.canvas = document.createElement("canvas");
    tunnel.canvas.width = Math.max(2, Math.round((v.videoWidth || 640) * escala));
    tunnel.canvas.height = Math.max(2, Math.round((v.videoHeight || 480) * escala));
    tunnel.ctx = tunnel.canvas.getContext("2d");
  }
  return tunnel.canvas;
}

function enviarFrameTunel() {
  if (!tunnel.activo) return void (tunnel.motivo = "inactivo");
  if (!signal?.abierto) return void (tunnel.motivo = "ws-cerrado");
  const v = $("video");
  if (!v.videoWidth) return void (tunnel.motivo = "video-sin-tamano");
  if (tunnel.aguante_hasta > 0) {
    tunnel.aguante_hasta--;
    return void (tunnel.motivo = "resolucion-ajustando");
  }
  const ahora = performance.now();
  if (ahora - tunnel.ultimo < 1000 / TUNEL_FPS) return void (tunnel.motivo = "limite-fps");
  tunnel.ultimo = ahora;
  tunnel.motivo = "enviado";
  const t0 = performance.now();
  try {
    const tpi = performance.now();
    const c = pintarEnCanvas();
    const td = performance.now();
    tunnel.ctx.drawImage(v, 0, 0, c.width, c.height);
    const tc = performance.now();
    tunnel.msDibujar = (tunnel.msDibujar || 0) * 0.85 + (tc - td) * 0.15;
    // toBlob es asincrono y su callback se aplaza cuando la pestana queda
    // oculta: con el encadenado anterior el envio se congelaba justo en
    // segundo plano, que es justo cuando tiene que funcionar. toDataURL es
    // sincrono, asi que el frame sale siempre. Paga un 33% mas de bytes por
    // el base64, a cambio de no depender de la cola de tareas.
    const url = c.toDataURL("image/jpeg", TUNEL_CALIDAD);
    const tb = performance.now();
    tunnel.msCodificar = (tunnel.msCodificar || 0) * 0.85 + (tb - tc) * 0.15;
    const b64 = url.slice(url.indexOf(",") + 1);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const te = performance.now();
    tunnel.msBase64 = (tunnel.msBase64 || 0) * 0.85 + (te - tb) * 0.15;
    signal.sendBytes(bytes.buffer);
    tunnel.msEnvio = (tunnel.msEnvio || 0) * 0.85 + (performance.now() - te) * 0.15;
    // Si el socket acumula sin vaciarse, es que el tunel no da mas: no tiene
    // sentido codificar frames que se quedaron haciendo cola.
    if (signal?.ws && typeof signal.ws.bufferedAmount === "number") {
      tunnel.bufferSocket = signal.ws.bufferedAmount;
    }
    const msTotal = performance.now() - t0;
    // Historial crudo por frame. Las medias moviles de arriba sirven para
    // vigilar en caliente, pero al depurar hay que comparar los valores
    // crudos del mismo frame: si las partes no suman el total, el tiempo se
    // va en otro sitio y hay que buscarlo alli, no suponerlo.
    tunnel.historia.push({
      pintar: +(td - tpi).toFixed(2),
      dibujar: +(tc - td).toFixed(2),
      codificar: +(tb - tc).toFixed(2),
      base64: +(te - tb).toFixed(2),
      envio: +(performance.now() - te).toFixed(2),
      total: +msTotal.toFixed(2),
    });
    if (tunnel.historia.length > 40) tunnel.historia.shift();
    tunnel.cuenta++;
    // Coste real de esta funcion, medida en produccion y no en un bucle
    // sintetico. Importa porque leer pixeles de un <video> con la pagina
    // oculta es lo mas caro que hace el telefono.
    tunnel.msMedio = tunnel.msMedio ? tunnel.msMedio * 0.85 + msTotal * 0.15 : msTotal;
    if (tunnel.cuenta % 30 === 1) {
      signal.send({
        t: "frame-info",
        data: `${c.width}x${c.height} ~${Math.round((bytes.length * TUNEL_FPS * 8) / 1024)}kbps`,
      });
    }
  } catch (_) {}
}

// Ritmo de captura. Hay que conseguir dos cosas a la vez: enviar frames sin
// parar aunque la pestana este oculta, y no quemar la CPU del telefono.
//
// Medido en este proyecto:
//   setInterval            -> ~0.5 FPS en segundo plano y ~5% de CPU visible
//   worker con temporizador-> ~0.3 FPS en segundo plano (tambien se frena)
//   MessageChannel en bucle-> 11 FPS en segundo plano, pero 92% de un nucleo
//   Atomics.wait en worker -> 11 FPS en segundo plano y ~0% de CPU
//
// Atomics.wait es una espera real del hilo: el worker duerme y no consume nada,
// y como no es un temporizador el navegador no la frena al ocultar la pestana.
const TRABAJADOR = `
let ctl = null;
function bucle() {
  while (Atomics.load(ctl, 0) === 0) {
    Atomics.wait(ctl, 1, 1, ${Math.round(1000 / TUNEL_FPS)});
    if (Atomics.load(ctl, 0) !== 0) return;
    postMessage('tick');
  }
}
onmessage = (e) => {
  const d = e.data;
  if (d.t === 'arrancar') {
    ctl = new Int32Array(d.ctl);
    Atomics.store(ctl, 0, 0);
    Atomics.store(ctl, 1, 1);
    bucle();
  } else if (d.t === 'parar' && ctl) {
    Atomics.store(ctl, 0, 1);
    Atomics.store(ctl, 1, 2);
    Atomics.notify(ctl, 1);
  }
};
`;

function arrancarCaptura() {
  if (tunnel.capturando) return;
  tunnel.capturando = true;

  const haySAB = window.crossOriginIsolated && typeof SharedArrayBuffer === "function";
  if (haySAB) {
    try {
      const ctl = new SharedArrayBuffer(8);
      const w = new Worker(URL.createObjectURL(new Blob([TRABAJADOR], { type: "application/javascript" })));
      w.onmessage = () => {
        if (!tunnel.activo || !tunnel.capturando) return;
        tunnel.vueltas++;
        enviarFrameTunel();
      };
      w.postMessage({ t: "arrancar", ctl });
      tunnel.trabajador = w;
      tunnel.ctl = ctl;
      report("tunel-motor", "worker con Atomics.wait (11 FPS sin CPU en segundo plano)");
      return;
    } catch (err) {
      report("tunel-motor", `Atomics no disponible (${err}), se usa MessageChannel`);
    }
  }

  if (tunnel.puerto) {
    tunnel.emisor.postMessage(0);
    return;
  }
  if (typeof MessageChannel === "function") {
    report("tunel-motor", "MessageChannel (funciona en segundo plano, pero gasta CPU)");
    const mc = new MessageChannel();
    // Ojo: un postMessage se entrega al puerto contrario. Se escucha en uno y
    // se manda por el otro, si no el bucle nunca arranca.
    tunnel.puerto = mc.port1;
    tunnel.emisor = mc.port2;
    tunnel.puerto.onmessage = () => {
      if (!tunnel.activo || !tunnel.capturando) return;
      tunnel.vueltas++;
      enviarFrameTunel();
      tunnel.emisor.postMessage(0);
    };
    tunnel.emisor.postMessage(0);
  } else {
    report("tunel-motor", "setInterval (este navegador no expone MessageChannel)");
    tunnel.timer = setInterval(enviarFrameTunel, 1000 / TUNEL_FPS);
  }
}

function pararCaptura() {
  tunnel.capturando = false;
  if (tunnel.trabajador) {
    try {
      if (tunnel.ctl) {
        const v = new Int32Array(tunnel.ctl);
        Atomics.store(v, 0, 1);
        Atomics.store(v, 1, 2);
        Atomics.notify(v, 1);
      }
      tunnel.trabajador.terminate();
    } catch (_) {}
    tunnel.trabajador = null;
    tunnel.ctl = null;
  }
  if (tunnel.timer) clearInterval(tunnel.timer);
  tunnel.timer = null;
  if (tunnel.rafId) cancelVideoFrameCallback(tunnel.rafId);
  tunnel.rafId = null;
}

function ajustarResolucionCamara(ideal) {
  // Copiar pixeles de un <video> es lo mas caro que hace el telefono: leer
  // 1280x720 para acabar en 480x270 son 921k pixeles por frame y en la pagina
  // oculta costaba 36 ms. Si la camara entrega ya 480x270 son 130k y el mismo
  // dibujado baja a 14 ms, con lo que el frame entero pasa de 88 a 26 ms. Por
  // eso, al entrar en modo tunel se le pide a la camara que entregue
  // directamente el tamaño que se va a enviar. Es una sugerencia: si el
  // navegador no la acepta, se sigue con la resolucion que haya.
  if (!localStream) return;
  const [pista] = localStream.getVideoTracks();
  if (!pista || typeof pista.applyConstraints !== "function") return;
  const s = pista.getSettings ? pista.getSettings() : {};
  if ((s.width || 0) <= ideal) return;
  pista
    .applyConstraints({ width: { ideal }, height: { ideal: Math.round((ideal * 9) / 16) } })
    .then(() => {
      const ahora = pista.getSettings ? pista.getSettings() : {};
      report("tunel-resolucion", `camara ${ahora.width}x${ahora.height}`);
      // Al cambiar la resolucion la pista se reinicia y entrega unos cuantos
      // frames en negro. Mandarlos se ve como un parpadeo en la consola, asi
      // que se retiene el envio hasta que la camara se estabiliza. Se cuenta
      // en ticks del worker y no con un setTimeout porque, con la pestana
      // oculta, ese setTimeout puede tardar 2 segundos en dispararse y
      // justamente ahi se quedaria la transmision parada. El canvas no se
      // rehace: con el origen ya al tamano final sale igual de grande.
      tunnel.aguante_hasta = 12;
    })
    .catch((err) => report("tunel-resolucion", `no se pudo ajustar: ${err}`));
}

function activarTunel(motivo) {
  if (tunnel.activo) return;
  tunnel.activo = true;
  window.tunelActivoPor = motivo;
  report("modo-tunel", motivo);
  ui("on", "Transmitiendo", "Enviando por el túnel seguro");
  if (tunnel.timer) clearInterval(tunnel.timer);
  tunnel.timer = null;
  ajustarResolucionCamara(TUNEL_ANCHO);
  arrancarCaptura();
}

function desactivarTunel() {
  tunnel.activo = false;
  pararCaptura();
  tunnel.cuenta = 0;
}

function openSignal() {
  signal = new Signal("phone", qs.get("t") || "");
  const policy = qs.get("relay") ? "relay" : null;
  window.addEventListener("beforeunload", () => signal.stop());

  signal.on("ready", (msg) => {
    window.__ice = msg.ice || [];
    ui("", "Conectando con tu PC…", "Un momento", false);
    if (qs.get("tunel")) activarTunel("forzado por el link");
  });

  signal.on("error", (msg) => {
    signal.stop();
    reset("No se pudo conectar");
    $("msg-sub").textContent = msg.msg || "El servidor rechazó la conexión.";
  });

  signal.on("signal", async (msg) => {
    const d = msg.data || {};
    if (d.kind === "ice") {
      if (peer) await peer.addIce(d.candidate);
      return;
    }
    if (d.kind !== "offer") return;
    if (qs.get("tunel")) {
      // Modo solo-tunel: se ignora WebRTC a proposito. Sirve para la
      // presentacion cuando el telefono esta en otra ciudad, y para
      // probar el transport sin depender de la red.
      activarTunel("modo-solo-tunel");
      return;
    }
    if (!localStream) {
      // La oferta llego antes de tener camara: si se suelta, la PC se queda
      // esperando una respuesta que nunca llega. Se pide una nueva.
      report("oferta-sin-camara", "reintentando");
      setTimeout(() => signal.send({ t: "name", name: "" }), 300);
      return;
    }

    if (peer) peer.close();
    peer = new Peer(window.__ice, (m) => signal.signal(m), { iceTransportPolicy: policy });

    peer.tiposIce = [];
    const baseIce = peer.pc.onicecandidate;
    peer.pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        const m = /typ (\w+)/.exec(ev.candidate.candidate);
        if (m) peer.tiposIce.push(m[1]);
      }
      if (baseIce) baseIce(ev);
    };

    peer.pc.onconnectionstatechange = () => {
      const s = peer.pc.connectionState;
      report("pc", s);
      if (s === "connected") {
        ui("on", "Transmitiendo", "Tu cámara se está viendo en tu PC", false);
      }
      if ((s === "failed" || s === "disconnected") && !tunnel.activo) {
        ui("err", "Se perdió la conexión", "Toca para volver a intentar", true);
        $("btn-start").disabled = false;
      }
    };
    peer.pc.oniceconnectionstatechange = () => {
      const s = peer.pc.iceConnectionState;
      const tipos = iceTipos();
      report("ice", `${s} candidatos=${tipos}`);
      // Si ICE falla ya no va a pasar nada: se cambia de transporte en el acto.
      if (s === "failed") activarTunel("ice-fallo");
      else if (s === "disconnected" && !tunnel.activo) activarTunel("se-corto-el-directo");
    };

    peer.pc.ondatachannel = (ev) => bindControl(ev.channel);
    for (const track of localStream.getTracks()) {
      const sender = peer.pc.addTrack(track, localStream);
      if (track.kind === "video") videoSender = sender;
    }

    await peer.setRemote(d.sdp);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    signal.signal({ kind: "answer", sdp: peer.pc.localDescription.toJSON() });

    watchdog = setTimeout(() => {
      if (peer && peer.pc.connectionState !== "connected" && !tunnel.activo) {
        ui("err", "No se pudo conectar", "Tu red y la de la PC están aisladas. Toca para reintentar.", true);
        $("btn-start").disabled = false;
      }
    }, 45000);

    // Red de seguridad: si en 7 segundos no hay video directo, el video se
    // manda por el tunel. Es lo que hace funcionar la demo con el telefono
    // en otra ciudad, donde no existe ruta directa posible.
    if (!qs.get("p2p")) {
      setTimeout(() => {
        const hayVideo = peer && peer.pc.connectionState === "connected";
        if (!hayVideo && !tunnel.activo) {
          activarTunel(`p2p-no-connecto (${peer ? peer.pc.iceConnectionState : "sin-pc"})`);
        }
      }, 7000);
    }
  });
}

async function flipCamera() {
  if (!localStream || !videoSender) return;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    if (devices.length < 2) return;
    const current = localStream.getVideoTracks()[0].getSettings().deviceId;
    const ids = devices.map((d) => d.deviceId);
    const next = devices[(ids.indexOf(current) + 1) % ids.length];
    const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: next.deviceId } } });
    const track = stream.getVideoTracks()[0];
    const old = localStream.getVideoTracks()[0];
    await videoSender.replaceTrack(track);
    localStream.removeTrack(old);
    localStream.addTrack(track);
    old.stop();
    $("video").srcObject = localStream;
  } catch (_) {
    /* se queda la camara actual */
  }
}

async function start() {
  $("btn-start").disabled = true;
  report("inicio");
  if (!(await openCamera())) {
    report("camara-fallo", lastCamError || "");
    return;
  }
  if (!signal) openSignal();
  else signal.ws.readyState === WebSocket.OPEN || signal.connect();
  report("camara-ok", `${localStream.getVideoTracks()[0].label || "cam"} ${localStream.getVideoTracks()[0].getSettings().width}x${localStream.getVideoTracks()[0].getSettings().height}`);
}

$("btn-start").onclick = start;
$("btn-stop").onclick = () => {
  signal?.stop();
  reset("Transmisión detenida");
};

// Cambiar de app o bloquear la pantalla NO corta la transmision: la pista
// sigue viva mientras la pestana exista. Solo se corta al cerrar la pestana.

if (!qs.get("t")) {
  ui("err", "Link incompleto", "Pide a tu PC que te mande el link de acceso otra vez", true);
} else {
  start();
}
