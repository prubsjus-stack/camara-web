"use strict";

const $ = (id) => document.getElementById(id);
const logEl = $("log");
const say = (m, c) => log(logEl, m, c);

let peer = null;
let dc = null;
const bitrate = new Bitrate();
let statsTimer = null;
let signal = null;

async function api(path) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${path}${sep}t=${encodeURIComponent(qs.get("t") || "")}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

function setLink(url) {
  const input = $("link");
  input.value = url || "";
  input.disabled = !url;
  $("btn-copy").disabled = !url;
  const qr = $("qr");
  if (url) {
    qr.classList.remove("wait");
    qr.innerHTML = `<img src="/api/qr.svg?t=${encodeURIComponent(qs.get("t") || "")}" alt="QR del link de acceso" width="220" height="220">`;
    $("m-note").textContent =
      "El link usa un túnel HTTPS público (obligatorio: el navegador solo concede la cámara en sitios seguros). " +
      "El canal de video va directo por WebRTC; el túnel solo transporta la negociación.";
  } else {
    qr.classList.add("wait");
    qr.textContent = "Esperando URL pública… (¿arrancó cloudflared?)";
    $("m-note").textContent = "Sin URL pública el teléfono no podrá abrir la página desde otra red.";
  }
}

function setPlaceholder(title, sub) {
  $("ph-title").textContent = title;
  $("ph-sub").textContent = sub;
}

function stopStream(reason) {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  if (peer) peer.close();
  peer = null;
  dc = null;
  $("video").srcObject = null;
  $("live").classList.remove("on");
  for (const b of ["btn-full", "btn-snap", "btn-flip", "btn-kick"]) $(b).disabled = true;
  for (const m of ["res", "fps", "kbps", "rtt", "codec", "path"]) $(`m-${m}`).textContent = "—";
  for (const m of ["res", "fps", "kbps", "rtt", "codec", "path"]) $(`m-${m}`).className = "na";
  setPill($("pill-phone"), "", "sin teléfono");
  setPlaceholder("Esperando al teléfono", reason || "Comparte el link de acceso y autoriza la cámara desde el teléfono.");
}

async function makeOffer() {
  if (peer) peer.close();

  peer = new Peer(window.__ice, (msg) => signal.signal(msg));
  peer.pc.oniceconnectionstatechange = () => {
    say(`ICE: ${peer.pc.iceConnectionState}`);
    if (peer.pc.iceConnectionState === "failed") setPlaceholder("Falló la conexión", "Revisa que el teléfono tenga internet; puede hacer falta un relé TURN.");
  };

  peer.pc.ondatachannel = (ev) => {
    dc = ev.channel;
    dc.onopen = () => say("canal de control abierto", "s");
    dc.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.t === "info") say(`teléfono: ${msg.name} · ${msg.width}x${msg.height} @${msg.fps}fps`, "s");
      if (msg.t === "cam") say(`teléfono cambió a cámara ${msg.facing}`);
    };
  };

  peer.pc.ontrack = (ev) => {
    $("video").srcObject = ev.streams[0] || new MediaStream([ev.track]);
    say(`pista recibida: ${ev.track.kind}`);
    if (ev.track.kind !== "video") return;
    $("live").classList.add("on");
    setPlaceholder("Recibiendo…", "");
    for (const b of ["btn-full", "btn-snap", "btn-flip", "btn-kick"]) $(b).disabled = false;
    pollStats();
  };

  peer.pc.addTransceiver("video", { direction: "recvonly" });
  peer.pc.addTransceiver("audio", { direction: "recvonly" });

  dc = peer.pc.createDataChannel("ctl");
  const offer = await peer.pc.createOffer();
  await peer.pc.setLocalDescription(offer);
  signal.signal({ kind: "offer", sdp: peer.pc.localDescription.toJSON() });
  say("oferta enviada al teléfono");
}

function pollStats() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = setInterval(async () => {
    if (!peer) return;
    const r = await readStats(peer.pc, "in");
    const kbps = bitrate.sample(r.bytes);
    const set = (id, val, ok = true) => {
      const el = $(`m-${id}`);
      el.textContent = val;
      el.className = ok ? "" : "na";
    };
    set("res", r.w ? `${r.w}x${r.h}` : "—", !!r.w);
    set("fps", r.fps || "—", !!r.fps);
    set("kbps", r.w ? `${kbps.toFixed(0)} kbps` : "—", !!r.w);
    set("rtt", r.rtt === null ? "n/d" : `${r.rtt} ms`, r.rtt !== null);
    set("codec", r.codec === "n/d" ? "—" : r.codec, r.codec !== "n/d");
    set("path", r.path, r.path !== "n/d");
    if (r.path !== "n/d") {
      setPill($("pill-path"), r.path.startsWith("TURN") ? "warn" : "ok", `ruta: ${r.path}`);
    }
  }, 1000);
}

function start(role) {
  signal = new Signal(role, qs.get("t") || "");
  window.addEventListener("beforeunload", () => signal.stop());

  signal.on("ready", async (msg) => {
    say("señalización lista");
    setPill($("pill-ws"), "ok", "señalización activa");
    try {
      const cfg = await api("/api/config");
      setLink(cfg.phoneLink);
      const turn = cfg.turnCount;
      $("m-turn").textContent = turn ? String(turn) : "ninguno (configura TURN)";
      $("m-turn").className = turn ? "" : "na";
    } catch (err) {
      say(`config: ${err.message}`, "e");
    }
    if (msg.ice) {
      say(`ICE: ${msg.ice.length} servidor(es) configurados`);
      window.__ice = msg.ice;
    }
  });

  signal.on("public-url", (msg) => {
    setLink(msg.url);
    say(msg.url ? "link público actualizado" : "sin link público");
  });

  signal.on("phone-joined", (msg) => {
    say(`teléfono conectado: ${msg.name}`, "s");
    setPill($("pill-phone"), "ok", msg.name);
    setPlaceholder("Negociando…", "Estableciendo el canal directo con el teléfono.");
    makeOffer();
  });

  signal.on("phone-left", () => {
    say("teléfono desconectado");
    stopStream();
  });

  signal.on("signal", async (msg) => {
    const d = msg.data || {};
    if (!peer) return;
    if (d.kind === "answer") {
      await peer.setRemote(d.sdp);
      say("respuesta del teléfono aplicada");
    } else if (d.kind === "ice") {
      await peer.addIce(d.candidate);
    }
  });

  signal.on("error", (msg) => say(`error: ${msg.msg || msg.code}`, "e"));

  signal.on("close", (msg) => {
    setPill($("pill-ws"), "err", `señalización caída (${msg.code})`);
    say(`señalización cerrada: ${msg.reason || msg.code}`, "e");
  });
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

$("btn-full").onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $("box").requestFullscreen?.();
};

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
  say("imagen guardada", "s");
};

$("btn-flip").onclick = () => dc?.readyState === "open" && dc.send(JSON.stringify({ t: "flip" }));
$("btn-kick").onclick = () => dc?.readyState === "open" && dc.send(JSON.stringify({ t: "stop" }));

start("owner");
