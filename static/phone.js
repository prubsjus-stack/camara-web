"use strict";

document.body.classList.add("is-phone");

const $ = (id) => document.getElementById(id);
const logEl = $("log");
const say = (m, c) => log(logEl, m, c);

let signal = null;
let peer = null;
let dc = null;
let localStream = null;
let videoSender = null;
let cameras = [];
let cameraIndex = 0;
const bitrate = new Bitrate();
let statsTimer = null;

const setState = (state, text) => setPill($("pill-tx"), state, `enviando: ${text}`);

function showStage(stage) {
  $("intro").style.display = stage === "intro" ? "block" : "none";
  $("box").style.display = stage === "live" ? "grid" : "none";
  $("controls").style.display = stage === "live" ? "block" : "none";
}

const info = (m) => ($("note-intro").textContent = m);

function deviceName() {
  const ua = navigator.userAgent;
  const kind = /iPhone|iPad|iPod/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : "Movil";
  return `${kind} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

async function openCamera() {
  const constraints = {
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: $("chk-audio").checked,
  };
  say("solicitando permiso de cámara…");
  try {
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    say(`cámara no disponible: ${err.name}`, "e");
    info(`No se pudo abrir la cámara (${err.name}). Revisa el candado de la barra de direcciones y los permisos del navegador, y prueba con Chrome o Firefox.`);
    showStage("intro");
    $("btn-start").disabled = false;
    throw err;
  }
  say("cámara autorizada");
  $("video").srcObject = localStream;
  showStage("live");
  $("ph").querySelector(".big").textContent = "Conectando con la PC…";
  localStream.getVideoTracks()[0].addEventListener("ended", () => {
    say("el navegador desactivó la cámara", "e");
    stop("El navegador desactivó la cámara.");
  });
}

function bindControl(channel) {
  dc = channel;
  dc.onopen = () => {
    say("canal de control abierto", "s");
    sendInfo();
  };
  dc.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === "flip") flipCamera();
    if (m.t === "stop") stop("La PC pidió detener la transmisión.");
  };
}

function openSignal() {
  signal = new Signal("phone", qs.get("t") || "", deviceName());
  window.addEventListener("beforeunload", () => signal.stop());

  signal.on("ready", (msg) => {
    setPill($("pill-ws"), "ok", "señalización activa");
    say(`señalización activa · ${(msg.ice || []).length} servidor(es) ICE`);
    window.__ice = msg.ice || [];
  });

  signal.on("error", (msg) => {
    say(`error del servidor: ${msg.msg || msg.code}`, "e");
    stop(msg.msg || "El servidor rechazó la conexión.");
  });

  signal.on("close", (msg) => {
    setPill($("pill-ws"), "err", `señalización caída (${msg.code})`);
    say(`señalización cerrada: ${msg.reason || msg.code}`, "e");
  });

  signal.on("signal", async (msg) => {
    const d = msg.data || {};
    if (d.kind === "ice") {
      if (peer) await peer.addIce(d.candidate);
      return;
    }
    if (d.kind !== "offer") return;

    say("oferta recibida de la PC");
    if (!localStream) await openCamera().catch(() => null);
    if (!localStream) return;

    if (peer) peer.close();
    peer = new Peer(window.__ice, (m) => signal.signal(m));

    peer.pc.onconnectionstatechange = () => {
      const s = peer.pc.connectionState;
      say(`conexión: ${s}`);
      if (s === "connected") {
        $("live").classList.add("on");
        $("ph").classList.add("hide");
        setState("ok", "en vivo");
        info("Transmitiendo. Cierra esta pestaña o pulsa «Detener» cuando termines.");
        startStats();
      }
      if (s === "failed" || s === "disconnected") {
        setState("err", s);
        $("live").classList.remove("on");
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
    say("respuesta enviada");
  });
}

function sendInfo() {
  if (!dc || dc.readyState !== "open") return;
  const s = localStream?.getVideoTracks()[0]?.getSettings?.() || {};
  dc.send(JSON.stringify({ t: "info", name: deviceName(), width: s.width || 0, height: s.height || 0, fps: s.frameRate || 0 }));
}

function startStats() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = setInterval(async () => {
    if (!peer) return;
    const r = await readStats(peer.pc, "out");
    $("m-res").textContent = r.w ? `${r.w}x${r.h}` : "—";
    $("m-fps").textContent = r.fps || "—";
    $("m-kbps").textContent = r.w ? `${bitrate.sample(r.bytes).toFixed(0)} kbps` : "—";
    $("m-codec").textContent = r.codec;
    $("m-path").textContent = r.path;
  }, 1000);
}

async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "videoinput");
}

async function useTrack(videoConstraints) {
  const next = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
  const track = next.getVideoTracks()[0];
  const old = localStream.getVideoTracks()[0];
  await videoSender.replaceTrack(track);
  localStream.removeTrack(old);
  localStream.addTrack(track);
  old.stop();
  track.addEventListener("ended", () => stop("El navegador desactivó la cámara."));
  sendInfo();
  return track;
}

async function flipCamera() {
  if (!localStream || !videoSender) return;
  try {
    cameras = await listCameras();
    if (cameras.length > 1) {
      const ids = cameras.map((c) => c.deviceId);
      const current = localStream.getVideoTracks()[0].getSettings().deviceId;
      cameraIndex = (ids.indexOf(current) + 1) % ids.length;
      await useTrack({ deviceId: { exact: ids[cameraIndex] } });
      say(`cámara cambiada (${cameras.length} disponibles)`);
    } else {
      const back = localStream.getVideoTracks()[0].getSettings().facingMode === "environment";
      await useTrack({ facingMode: back ? "user" : "environment" });
      say("cámara cambiada (frontal ↔ trasera)");
    }
  } catch (err) {
    say(`no se pudo cambiar de cámara: ${err.name}`, "e");
  }
}

function stop(message) {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  if (peer) peer.close();
  peer = null;
  dc = null;
  videoSender = null;
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  $("video").srcObject = null;
  $("live").classList.remove("on");
  setState("", "detenido");
  showStage("intro");
  info(message || "Transmisión detenida.");
  say("transmisión detenida");
}

$("btn-start").onclick = async () => {
  $("btn-start").disabled = true;
  showStage("live");
  try {
    await openCamera();
    if (!signal) openSignal();
  } catch (_) {
    /* el mensaje ya quedó en pantalla */
  }
};

$("btn-flip").onclick = flipCamera;
$("btn-stop").onclick = () => stop("Transmisión detenida desde el teléfono.");
$("chk-audio").onchange = () => {
  const t = localStream?.getAudioTracks()[0];
  if (t) t.enabled = $("chk-audio").checked;
};
$("btn-mic").onclick = () => {
  const t = localStream?.getAudioTracks()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  $("btn-mic").textContent = t.enabled ? "Silenciar micrófono" : "Activar micrófono";
};

if (!qs.get("t")) {
  say("falta el token de acceso: abre el link completo que dio la PC", "e");
  info("El link está incompleto. Pide a la PC que vuelva a generar el link de acceso.");
  $("btn-start").disabled = true;
} else {
  showStage("live");
  openCamera()
    .then(openSignal)
    .catch(() => {});
}
