// Exercises cloud API test devkey inference behavior with deterministic Worker route fixtures.
import { readFileSync } from "node:fs";

const KEY = readFileSync("/tmp/view-work/dev-key.txt", "utf8").trim();
const API = "https://api.elizacloud.ai";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(m, p, { body, base } = {}) {
  const r = await fetch((base || API) + p, {
    method: m,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${KEY}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null;
  const t = await r.text();
  try {
    d = t ? JSON.parse(t) : null;
  } catch {
    d = t;
  }
  return { s: r.status, d };
}
const c = await j("POST", "/api/v1/eliza/agents", {
  body: { agentName: `devkey-${Date.now() % 100000}`, alwaysOn: true },
});
const cd = c.d?.data || c.d || {};
const id = cd.id || cd.agentId;
log("create", c.s, "id", id, "tier", cd.executionTier || cd.execution_tier);
if (!id) {
  log("FAIL no agent");
  process.exit(1);
}
const pub = `https://${id}.elizacloud.ai`;
let ready = false;
const t0 = Date.now();
for (let i = 0; i < 40; i++) {
  const el = Math.round((Date.now() - t0) / 1000);
  let st = 0;
  try {
    st = (await j("GET", "/api/status", { base: pub })).s;
  } catch {}
  log(`t=${el}s subdomain=/api/status->${st}`);
  if (st === 200) {
    ready = true;
    break;
  }
  await sleep(8000);
}
if (ready) {
  const conv = await j("POST", "/api/conversations", { base: pub, body: {} });
  const cid = conv.d?.conversation?.id || conv.d?.id || id;
  const chat = await j("POST", `/api/conversations/${cid}/messages`, {
    base: pub,
    body: {
      text: "Reply with exactly: dev-key-inference-works",
      channelType: "DM",
    },
  });
  const reply = chat.d?.text || JSON.stringify(chat.d);
  log(`CLOUD CHAT status=${chat.s} reply="${String(reply).slice(0, 90)}"`);
  log(
    chat.s === 200 && String(reply).length > 2
      ? "✅ CLOUD INFERENCE WORKS WITH DEV KEY"
      : "❌ unexpected",
  );
}
const del = await j("DELETE", `/api/v1/eliza/agents/${id}`);
log("cleanup", del.s);
process.exit(0);
