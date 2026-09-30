"use strict";

const qs = new URLSearchParams(location.search);

function log(el, msg, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.prepend(line);
  while (el.childElementCount > 120) el.lastElementChild.remove();
}

function setPill(el, state, text) {
  el.className = `pill ${state}`;
  el.querySelector("span:last-child").textContent = text;
}

class Peer {
  constructor(iceServers, onSignal, opts) {
    this.onSignal = onSignal;
    const cfg = { iceServers: iceServers || [], bundlePolicy: "max-bundle" };
    // ?relay=1 fuerza relay: solo se admiten candidatos TURN. Sirve para
    // comprobar que los relés funcionan, porque si no el navegador siempre
    // escoge una ruta directa de la red local y nunca los llega a usar.
    if (opts && opts.iceTransportPolicy) cfg.iceTransportPolicy = opts.iceTransportPolicy;
    this.pc = new RTCPeerConnection(cfg);
    this.pending = [];
    this.remoteReady = false;
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) this.onSignal({ kind: "ice", candidate: ev.candidate.toJSON() });
    };
  }

  async addIce(candidate) {
    if (!candidate) return;
    if (!this.remoteReady) {
      this.pending.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn("addIceCandidate:", err.message);
    }
  }

  async setRemote(desc) {
    await this.pc.setRemoteDescription(desc);
    this.remoteReady = true;
    const queued = this.pending.splice(0);
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn("addIceCandidate (buffered):", err.message);
      }
    }
  }

  close() {
    try {
      this.pc.close();
    } catch (_) {}
  }
}

class Signal extends EventTarget {
  constructor(role, token, name) {
    super();
    this.role = role;
    this.token = token;
    this.name = name || "";
    this.ws = null;
    this.backoff = 500;
    this.closed = false;
    this.fatal = false;
    this.connect();
  }

  connect() {
    if (this.closed) return;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const params = new URLSearchParams({ t: this.token });
    if (this.name) params.set("n", this.name);
    const url = `${scheme}://${location.host}/ws?${params.toString()}`;
    this.ws = new WebSocket(url, [this.role]);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.backoff = 500;
      this.emit("open");
    };

    this.ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        this.emit("frame", ev.data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      if (msg.t === "error") this.fatal = true;
      this.emit(msg.t, msg);
    };

    this.ws.onclose = (ev) => {
      this.emit("close", { code: ev.code, reason: ev.reason });
      if (this.closed || this.fatal) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 5000);
    };

    this.ws.onerror = () => this.ws.close();
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  on(type, fn) {
    this.addEventListener(type, (ev) => fn(ev.detail));
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  signal(data) {
    this.send({ t: "signal", data });
  }

  sendBytes(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  get abierto() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  stop() {
    this.closed = true;
    if (this.ws) this.ws.close();
  }
}

const codecLabel = (mime) => (mime ? mime.replace("video/", "").toUpperCase() : "n/d");

async function readStats(pc, direction) {
  const report = { bytes: 0, fps: 0, w: 0, h: 0, path: "n/d", rtt: null, codec: "n/d" };
  const stats = await pc.getStats();
  const want = direction === "in" ? "inbound-rtp" : "outbound-rtp";
  let pairId = null;
  let codecId = null;

  stats.forEach((s) => {
    if (s.type === "transport" && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
    if (s.type === want && s.kind === "video") {
      report.bytes = s.bytesReceived || s.bytesSent || 0;
      report.fps = Math.round(s.framesPerSecond || 0);
      report.w = s.frameWidth || 0;
      report.h = s.frameHeight || 0;
      codecId = s.codecId;
    }
  });

  if (codecId) {
    const codec = stats.get(codecId);
    if (codec) report.codec = codecLabel(codec.mimeType);
  }

  const pair = pairId ? stats.get(pairId) : null;
  if (pair && pair.state === "succeeded") {
    const type = (id) => {
      const c = id ? stats.get(id) : null;
      return c ? c.candidateType : null;
    };
    const local = type(pair.localCandidateId);
    const remote = type(pair.remoteCandidateId);
    const relay = local === "relay" || remote === "relay";
    const parts = [relay ? "TURN (relé)" : "directo"];
    if (local) parts.push(`local ${local}`);
    if (remote) parts.push(`remoto ${remote}`);
    report.path = parts.join(" · ");
    report.rtt = Math.round((pair.currentRoundTripTime || 0) * 1000);
  }

  return report;
}

class Bitrate {
  constructor() {
    this.prev = { t: 0, bytes: 0 };
  }
  sample(bytes) {
    const now = performance.now();
    if (!this.prev.t) {
      this.prev = { t: now, bytes };
      return 0;
    }
    const dt = (now - this.prev.t) / 1000;
    const kbps = dt > 0 ? ((bytes - this.prev.bytes) * 8) / dt / 1000 : 0;
    this.prev = { t: now, bytes };
    return Math.max(0, kbps);
  }
}
