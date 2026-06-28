// Multi-agent lifecycle fuzz: create / talk / delete in a stress sequence,
// asserting invariants at every step. Mints its own dev key via SIWE (ethers).
// Run: node test/_lifecycle-fuzz.mjs  (from packages/cloud/api)
import { Wallet } from "ethers";

const API = process.env.CLOUD_API || "https://api.elizacloud.ai";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let KEY = "";
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
};

async function j(method, path, { body, base, noAuth } = {}) {
  const r = await fetch((base || API) + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(noAuth ? {} : { authorization: `Bearer ${KEY}` }),
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

async function mintKey() {
  let nonce = null;
  for (let i = 0; i < 8; i++) {
    const r = await j("GET", "/api/auth/siwe/nonce?chainId=1", {
      noAuth: true,
    });
    if (r.s === 200 && r.d?.nonce) {
      nonce = r.d;
      break;
    }
    await sleep(2500);
  }
  if (!nonce) throw new Error("no nonce");
  const w = Wallet.createRandom();
  const msg =
    `${nonce.domain} wants you to sign in with your Ethereum account:\n${w.address}\n\n${nonce.statement}\n\n` +
    `URI: ${nonce.uri}\nVersion: ${nonce.version || "1"}\nChain ID: ${nonce.chainId || 1}\nNonce: ${nonce.nonce}\nIssued At: ${new Date().toISOString()}`;
  const sig = await w.signMessage(msg);
  const v = await j("POST", "/api/auth/siwe/verify", {
    noAuth: true,
    body: { message: msg, signature: sig },
  });
  if (!v.d?.apiKey) throw new Error(`verify failed ${v.s}`);
  return v.d.apiKey;
}

// ── lifecycle primitives ────────────────────────────────────────────────────
async function createAgent(label) {
  const c = await j("POST", "/api/v1/eliza/agents", {
    body: { agentName: label, alwaysOn: true },
  });
  const cd = c.d?.data || c.d || {};
  const id = cd.id || cd.agentId;
  return { id, status: c.s, tier: cd.executionTier || cd.execution_tier };
}
async function waitReady(id, budgetMs = 5 * 60 * 1000) {
  const pub = `https://${id}.elizacloud.ai`;
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    let st = 0;
    try {
      st = (await j("GET", "/api/status", { base: pub })).s;
    } catch {}
    if (st === 200)
      return { ready: true, sec: Math.round((Date.now() - t0) / 1000) };
    await sleep(8000);
  }
  return { ready: false, sec: Math.round((Date.now() - t0) / 1000) };
}
async function talk(id, text) {
  const pub = `https://${id}.elizacloud.ai`;
  const conv = await j("POST", "/api/conversations", { base: pub, body: {} });
  const cid = conv.d?.conversation?.id || conv.d?.id || id;
  const chat = await j("POST", `/api/conversations/${cid}/messages`, {
    base: pub,
    body: { text, channelType: "DM" },
  });
  return { status: chat.s, reply: chat.d?.text || chat.d?.message?.text || "" };
}
async function del(id) {
  const r = await j("DELETE", `/api/v1/eliza/agents/${id}`);
  return { status: r.s, jobId: r.d?.data?.jobId || r.d?.jobId };
}
async function waitGone(id, budgetMs = 3 * 60 * 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const r = await j("GET", `/api/v1/eliza/agents/${id}`);
    if (r.s === 404)
      return { gone: true, sec: Math.round((Date.now() - t0) / 1000) };
    await sleep(6000);
  }
  return { gone: false, sec: Math.round((Date.now() - t0) / 1000) };
}
async function listAgentIds() {
  const r = await j("GET", "/api/v1/eliza/agents");
  const arr = r.d?.data || r.d?.agents || (Array.isArray(r.d) ? r.d : []);
  return (Array.isArray(arr) ? arr : [])
    .map((a) => a.id || a.agentId)
    .filter(Boolean);
}

async function main() {
  KEY = await mintKey();
  check("dev-login mints key", !!KEY, `len=${KEY.length}`);

  // 1. CREATE A
  const A = await createAgent("fuzz-A");
  check("create A", !!A.id, `id=${A.id} tier=${A.tier}`);
  const ra = await waitReady(A.id);
  check("A ready", ra.ready, `${ra.sec}s`);
  // 2. TALK A
  const ta = await talk(A.id, "Say: A-one");
  check(
    "talk A",
    ta.status === 200 && ta.reply.length > 0,
    `status=${ta.status} reply="${ta.reply.slice(0, 40)}"`,
  );
  // 3. DELETE A
  const da = await del(A.id);
  check(
    "delete A accepted",
    da.status >= 200 && da.status < 300,
    `status=${da.status}`,
  );
  const ga = await waitGone(A.id);
  check("A gone (404)", ga.gone, `${ga.sec}s`);
  // INVARIANT: talking to deleted A fails
  const tadead = await talk(A.id, "still there?");
  check(
    "talk deleted A fails (no zombie)",
    tadead.status >= 400,
    `status=${tadead.status}`,
  );

  // 4 & 5. CREATE B, CREATE C (concurrent)
  const [B, C] = await Promise.all([
    createAgent("fuzz-B"),
    createAgent("fuzz-C"),
  ]);
  check("create B", !!B.id, `id=${B.id}`);
  check("create C", !!C.id, `id=${C.id}`);
  check("B and C are distinct", B.id !== C.id, "");
  const [rb, rc] = await Promise.all([waitReady(B.id), waitReady(C.id)]);
  check("B ready", rb.ready, `${rb.sec}s`);
  check("C ready", rc.ready, `${rc.sec}s`);

  // 6. SWITCH (to B) + talk B — switching = choosing which agent to address
  const tb = await talk(B.id, "Say: B-switched");
  check(
    "switch→talk B",
    tb.status === 200 && tb.reply.length > 0,
    `status=${tb.status} reply="${tb.reply.slice(0, 40)}"`,
  );
  // INVARIANT: both B and C present in the list (switch didn't drop one)
  const midList = await listAgentIds();
  check(
    "B & C both listed",
    midList.includes(B.id) && midList.includes(C.id),
    `count=${midList.length}`,
  );

  // 7. DELETE B
  const db = await del(B.id);
  check(
    "delete B accepted",
    db.status >= 200 && db.status < 300,
    `status=${db.status}`,
  );
  const gb = await waitGone(B.id);
  check("B gone (404)", gb.gone, `${gb.sec}s`);

  // 8. TALK C (after B deleted — C must be unaffected)
  const tc = await talk(C.id, "Say: C-survives");
  check(
    "talk C after B deleted",
    tc.status === 200 && tc.reply.length > 0,
    `status=${tc.status} reply="${tc.reply.slice(0, 40)}"`,
  );

  // 9. DELETE C + idempotent re-delete
  const dc = await del(C.id);
  check(
    "delete C accepted",
    dc.status >= 200 && dc.status < 300,
    `status=${dc.status}`,
  );
  const gc = await waitGone(C.id);
  check("C gone (404)", gc.gone, `${gc.sec}s`);
  const dc2 = await del(C.id);
  check(
    "re-delete C is safe (404/2xx, no 500)",
    dc2.status === 404 || (dc2.status >= 200 && dc2.status < 300),
    `status=${dc2.status}`,
  );

  // FINAL: no fuzz agents leaked
  const finalList = await listAgentIds();
  const leaked = [A.id, B.id, C.id].filter((id) => finalList.includes(id));
  check(
    "no agents leaked",
    leaked.length === 0,
    leaked.length ? `leaked=${leaked.join(",")}` : "clean",
  );

  const pass = results.filter((r) => r.ok).length;
  log(`\n=== LIFECYCLE FUZZ: ${pass}/${results.length} passed ===`);
  for (const r of results.filter((x) => !x.ok))
    log(`  FAIL: ${r.name} — ${r.detail}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
main().catch((e) => {
  log("FATAL", e.message);
  process.exit(2);
});
