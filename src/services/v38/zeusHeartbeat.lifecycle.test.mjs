import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { ZeusHeartbeatOrchestrator, heartbeatSigningBytes } from "./zeusHeartbeat.mjs";

function fixture(overrides = {}) {
  const server = generateKeyPairSync("ed25519"), node = generateKeyPairSync("ed25519");
  const transport = new EventTarget();
  transport.readyState = 1;
  transport.sent = [];
  transport.send = (raw) => transport.sent.push(JSON.parse(raw));
  const zeus = new ZeusHeartbeatOrchestrator({
    serverPrivateKey: server.privateKey,
    authorizeNode: async () => true,
    canDispatch: async () => true,
    validateProvenance: async () => true,
    pingTimeoutMs: 100,
    timeoutMs: 100,
    ...overrides,
  });
  return { zeus, node, transport, register: () => zeus.registerWorker({ id: "fixture-node", publicKey: node.publicKey, capabilities: ["DOM_PARSE"] }, transport) };
}

test("shutdown rejects an enrollment waiting on authorization", async () => {
  let release;
  const f = fixture({ authorizeNode: () => new Promise((resolve) => { release = resolve; }) });
  try {
    const enrollment = f.register();
    const rejected = assert.rejects(enrollment, /ORCHESTRATOR_STOPPED/);
    f.zeus.close();
    release(true);
    await rejected;
    assert.equal(f.zeus.workers.size, 0);
    assert.equal(f.zeus.enrolling, 0);
  } finally { f.zeus.close(); }
});

test("shutdown prevents a task send after pending dispatch authorization", async () => {
  let release;
  const f = fixture({ canDispatch: () => new Promise((resolve) => { release = resolve; }) });
  try {
    await f.register();
    const ping = f.zeus.pingNode("fixture-node");
    const frame = { ...f.transport.sent.at(-1), kind: "node.pong" };
    frame.signature = sign(null, heartbeatSigningBytes(frame), f.node.privateKey).toString("base64url");
    await f.zeus.receive(f.zeus.workers.get("fixture-node"), JSON.stringify(frame));
    await ping;
    const task = f.zeus.dispatchTask({ id: "fixture-task", type: "DOM_PARSE", scopeKey: "fixture-scope", payload: "fixture input" });
    const rejected = assert.rejects(task, /NO_ELIGIBLE_WORKER|ORCHESTRATOR_STOPPED/);
    f.zeus.close();
    release(true);
    await rejected;
    assert.equal(f.transport.sent.filter((item) => item.taskType).length, 0);
    assert.equal(f.zeus.pending.size, 0);
  } finally { f.zeus.close(); }
});
