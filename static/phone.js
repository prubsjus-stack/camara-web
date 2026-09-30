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

function openSignal() {
  signal = new Signal("phone", qs.get("t") || "");
  const policy = qs.get("relay") ? "relay" : null;
  window.addEventListener("beforeunload", () => signal.stop());

  signal.on("ready", (msg) => {
    window.__ice = msg.ice || [];
    ui("", "Conectando con tu PC…", "Un momento", false);
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
      if (s === "failed" || s === "disconnected") {
        ui("err", "Se perdió la conexión", "Toca para volver a intentar", true);
        $("btn-start").disabled = false;
      }
    };
    peer.pc.oniceconnectionstatechange = () => {
      const s = peer.pc.iceConnectionState;
      const tipos = iceTipos();
      report("ice", `${s} candidatos=${tipos}`);
      if (s === "failed") {
        ui("err", "No hay conexión posible", "La red bloquea la conexión directa. Toca para reintentar.", true);
        $("btn-start").disabled = false;
      }
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
      if (peer && peer.pc.connectionState !== "connected") {
        ui("err", "No se pudo conectar", "Tu red y la de la PC están aisladas. Toca para reintentar.", true);
        $("btn-start").disabled = false;
      }
    }, 45000);
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
