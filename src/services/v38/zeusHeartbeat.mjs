import { randomUUID, sign, verify } from "node:crypto";
import { ZeusOrchestrator } from "./foundation.mjs";

const signaturePattern = /^[A-Za-z0-9_-]{86}$/;
export function heartbeatSigningBytes(frame) {
  return Buffer.from(JSON.stringify(["VALHALLA_HEARTBEAT_V1", frame.v, frame.kind, frame.nodeId, frame.connectionId, frame.nonce, frame.sentAt, frame.expiresAt]));
}

export class ZeusHeartbeatOrchestrator extends ZeusOrchestrator {
  #serverPrivateKey;
  constructor(options = {}) {
    const { serverPrivateKey, pingTimeoutMs = 5000, staleAfterMs = 90000 } = options;
    const policy = options.canDispatch;
    if (serverPrivateKey?.asymmetricKeyType !== "ed25519" || serverPrivateKey.type !== "private" || typeof policy !== "function") throw new Error("HEARTBEAT_POLICY_REQUIRED");
    if (!Number.isInteger(pingTimeoutMs) || pingTimeoutMs < 10 || pingTimeoutMs > 10000 || !Number.isInteger(staleAfterMs) || staleAfterMs < pingTimeoutMs || staleAfterMs > 300000) throw new Error("INVALID_HEARTBEAT_LIMITS");
    super({ ...options, canDispatch: async (worker, task) => worker.heartbeat?.status === "online" && (await policy(worker, task)) === true && !this.stopped && this.workers.get(worker.id) === worker && worker.heartbeat.status === "online" && Date.now() - worker.heartbeat.lastSeenAt <= staleAfterMs });
    this.#serverPrivateKey = serverPrivateKey;
    Object.assign(this, { pingTimeoutMs, staleAfterMs });
    this.pings = new Map();
    this.enrolling = 0;
    this.stopped = false;
  }

  async registerWorker(record, transport) {
    if (this.stopped || this.workers.size + this.enrolling >= 64 || record?.publicKey?.asymmetricKeyType !== "ed25519" || record.publicKey.type !== "public") throw new Error("NODE_DENIED");
    this.enrolling++;
    try {
      await super.registerWorker(record, transport);
      const worker = this.workers.get(record.id);
      if (this.stopped) {
        if (worker) {
          worker.quarantined = true;
          transport.removeEventListener("message", worker.message);
          transport.removeEventListener("close", worker.close);
          this.workers.delete(record.id);
        }
        throw new Error("ORCHESTRATOR_STOPPED");
      }
      worker.heartbeat = { connectionId: randomUUID(), status: "unknown", lastProbeAt: 0, lastSeenAt: null, rttMs: null, misses: 0 };
      const priorClose = worker.close;
      transport.removeEventListener("close", priorClose);
      worker.close = () => { this.cancelPing(worker.id, "WORKER_DISCONNECTED"); worker.heartbeat.status = "disconnected"; priorClose(); };
      transport.addEventListener("close", worker.close);
    } finally { this.enrolling--; }
  }

  async dispatchTask(task) {
    if (this.stopped) throw new Error("ORCHESTRATOR_STOPPED");
    return super.dispatchTask(task);
  }

  pingNode(nodeId) {
    const worker = this.workers.get(nodeId);
    if (this.stopped || !worker || worker.quarantined || worker.transport.readyState !== 1) return Promise.reject(new Error("NODE_UNAVAILABLE"));
    if (this.pings.has(nodeId)) return this.pings.get(nodeId).promise;
    const now = Date.now();
    if (now - worker.heartbeat.lastProbeAt < 1000) return Promise.reject(new Error("PING_RATE_LIMITED"));
    worker.heartbeat.lastProbeAt = now;
    const frame = { v: 1, kind: "zeus.ping", nodeId, connectionId: worker.heartbeat.connectionId, nonce: randomUUID(), sentAt: now, expiresAt: now + this.pingTimeoutMs };
    frame.signature = sign(null, heartbeatSigningBytes(frame), this.#serverPrivateKey).toString("base64url");
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const pending = { frame, worker, promise, resolve, reject, started: performance.now() };
    pending.timer = setTimeout(() => {
      if (this.pings.get(nodeId) !== pending) return;
      this.pings.delete(nodeId);
      worker.heartbeat.misses++;
      worker.heartbeat.status = worker.heartbeat.misses >= 3 ? "offline" : "suspect";
      reject(new Error("PING_TIMEOUT"));
    }, this.pingTimeoutMs);
    this.pings.set(nodeId, pending);
    try { worker.transport.send(JSON.stringify(frame)); }
    catch { this.cancelPing(nodeId, "PING_SEND_FAILED"); worker.heartbeat.status = "unavailable"; }
    return promise;
  }

  async receive(worker, raw) {
    let frame;
    try { if (typeof raw === "string" && Buffer.byteLength(raw) <= 2048) frame = JSON.parse(raw); } catch {}
    if (frame?.kind !== "node.pong") return super.receive(worker, raw);
    const pending = this.pings.get(worker.id);
    if (!pending || pending.processing || this.workers.get(worker.id) !== worker) return;
    const expected = pending.frame;
    if (frame.v !== 1 || frame.nodeId !== worker.id || frame.connectionId !== expected.connectionId || frame.nonce !== expected.nonce || frame.sentAt !== expected.sentAt || frame.expiresAt !== expected.expiresAt || Date.now() >= frame.expiresAt || !signaturePattern.test(frame.signature ?? "")) return;
    try {
      if (!verify(null, heartbeatSigningBytes(frame), worker.publicKey, Buffer.from(frame.signature, "base64url"))) return;
      pending.processing = true;
      const allowed = await this.authorizeNode(worker);
      if (this.pings.get(worker.id) !== pending || Date.now() >= frame.expiresAt) return;
      if (allowed !== true) { worker.quarantined = true; this.cancelPing(worker.id, "NODE_DENIED"); return; }
      clearTimeout(pending.timer);
      this.pings.delete(worker.id);
      Object.assign(worker.heartbeat, { status: "online", lastSeenAt: Date.now(), rttMs: Math.max(0, performance.now() - pending.started), misses: 0 });
      pending.resolve(this.nodeHealth(worker.id));
    } catch { this.cancelPing(worker.id, "HEARTBEAT_VALIDATION_FAILED"); worker.heartbeat.status = "unavailable"; }
  }

  nodeHealth(nodeId) {
    const worker = this.workers.get(nodeId);
    if (!worker) return { nodeId, status: "unknown", modelHealth: "NOT_CHECKED" };
    const state = worker.heartbeat;
    const status = worker.quarantined ? "quarantined" : state.status === "online" && Date.now() - state.lastSeenAt > this.staleAfterMs ? "stale" : state.status;
    return { nodeId, status, lastSeenAt: state.lastSeenAt, rttMs: state.rttMs, misses: state.misses, modelHealth: "NOT_CHECKED" };
  }

  pingAll() { return Promise.allSettled([...this.workers.keys()].map((id) => this.pingNode(id))); }
  cancelPing(nodeId, code) { const pending = this.pings.get(nodeId); if (!pending) return; clearTimeout(pending.timer); this.pings.delete(nodeId); pending.reject(new Error(code)); }
  close() {
    this.stopped = true;
    for (const worker of this.workers.values()) worker.quarantined = true;
    for (const id of this.pings.keys()) this.cancelPing(id, "ORCHESTRATOR_STOPPED");
    super.close();
  }
}

export function createHeartbeatResponder({ nodeId, privateKey, serverPublicKey, send }) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(nodeId) || privateKey?.asymmetricKeyType !== "ed25519" || privateKey.type !== "private" || serverPublicKey?.asymmetricKeyType !== "ed25519" || serverPublicKey.type !== "public" || typeof send !== "function") throw new Error("HEARTBEAT_POLICY_REQUIRED");
  const seen = new Map();
  return (raw) => {
    try {
      if (typeof raw !== "string" || Buffer.byteLength(raw) > 2048) return false;
      const frame = JSON.parse(raw), now = Date.now();
      if (frame.v !== 1 || frame.kind !== "zeus.ping" || frame.nodeId !== nodeId || typeof frame.connectionId !== "string" || frame.connectionId.length > 64 || typeof frame.nonce !== "string" || frame.nonce.length > 64 || !Number.isSafeInteger(frame.sentAt) || !Number.isSafeInteger(frame.expiresAt) || frame.sentAt > now + 30000 || frame.expiresAt <= now || frame.expiresAt <= frame.sentAt || frame.expiresAt - frame.sentAt > 10000 || !signaturePattern.test(frame.signature ?? "")) return false;
      if (!verify(null, heartbeatSigningBytes(frame), serverPublicKey, Buffer.from(frame.signature, "base64url"))) return false;
      for (const [nonce, expiry] of seen) if (expiry <= now) seen.delete(nonce);
      if (seen.has(frame.nonce) || seen.size >= 256) return false;
      seen.set(frame.nonce, frame.expiresAt);
      const pong = { ...frame, kind: "node.pong" };
      pong.signature = sign(null, heartbeatSigningBytes(pong), privateKey).toString("base64url");
      send(JSON.stringify(pong));
      return true;
    } catch { return false; }
  };
}
