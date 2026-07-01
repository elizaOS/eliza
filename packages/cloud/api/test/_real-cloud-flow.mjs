// Real-cloud end-to-end flow validator (run from packages/cloud/api with node).
// Mints a SIWE key against api.elizacloud.ai, then exercises:
//   create agent -> provision -> poll job -> shared chat -> wait dedicated ready
//   -> conversation import -> deprovision (delete container).
// Prints a step-by-step PASS/FAIL report. No mocks — hits the live cloud.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

const API = process.env.CLOUD_API || "https://api.elizacloud.ai";
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(method, path, { token, body, base } = {}) {
  const url = (base || API) + path;
  const res = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const txt = await res.text();
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = txt;
  }
  return { status: res.status, data };
}

const results = [];
const step = (name, ok, detail) => {
  results.push({ name, ok, detail });
  log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  // 1. SIWE mint
  const nonceRes = await j("GET", "/api/auth/siwe/nonce?chainId=1");
  step(
    "SIWE nonce",
    nonceRes.status === 200 && !!nonceRes.data?.nonce,
    `status=${nonceRes.status}`,
  );
  if (nonceRes.status !== 200) return done();
  const n = nonceRes.data;
  const account = privateKeyToAccount(generatePrivateKey());
  const message = createSiweMessage({
    address: account.address,
    chainId: n.chainId || 1,
    domain: n.domain,
    nonce: n.nonce,
    uri: n.uri,
    version: n.version || "1",
    statement: n.statement,
  });
  const signature = await account.signMessage({ message });
  const verifyRes = await j("POST", "/api/auth/siwe/verify", {
    body: { message, signature },
  });
  const token = verifyRes.data?.apiKey;
  step(
    "SIWE verify -> apiKey",
    verifyRes.status === 200 && !!token,
    `status=${verifyRes.status} org=${verifyRes.data?.organization?.id || "?"}`,
  );
  if (!token) return done();

  // sanity: authed call
  const meRes = await j("GET", "/api/v1/user", { token });
  step("authed /api/v1/user", meRes.status === 200, `status=${meRes.status}`);

  // 2. Create agent
  const agentName = `e2e-test-${account.address.slice(2, 8)}`;
  const createRes = await j("POST", "/api/v1/eliza/agents", {
    token,
    body: { agentName, alwaysOn: true, autoProvision: false },
  });
  const d = createRes.data?.data || createRes.data || {};
  const agentId = d.id || d.agentId || createRes.data?.id;
  const tier = d.executionTier || d.execution_tier;
  step(
    "create agent",
    (createRes.status === 200 ||
      createRes.status === 201 ||
      createRes.status === 202) &&
      !!agentId,
    `status=${createRes.status} id=${agentId} tier=${tier} source=${createRes.data?.source}`,
  );
  if (!agentId) return done();

  // 3. Provision (dedicated container)
  const provRes = await j("POST", `/api/v1/eliza/agents/${agentId}/provision`, {
    token,
  });
  const pd = provRes.data?.data || {};
  step(
    "provision",
    provRes.status >= 200 && provRes.status < 300,
    `status=${provRes.status} source=${provRes.data?.source} jobId=${pd.jobId} bridge=${pd.bridgeUrl ? "Y" : "N"} webUi=${pd.webUiUrl ? "Y" : "N"}`,
  );

  // 4. Shared chat immediately (while container boots) — conversationId === agentId
  const sharedBase = `${API}/api/v1/eliza/agents/${agentId}`;
  const chatRes = await j("POST", `/api/conversations/${agentId}/messages`, {
    token,
    base: sharedBase,
    body: { text: "Hello, reply with the single word: working" },
  });
  step(
    "shared chat send",
    chatRes.status === 200 && typeof chatRes.data?.text === "string",
    `status=${chatRes.status} reply="${String(chatRes.data?.text || chatRes.data?.error || "").slice(0, 50)}"`,
  );
  const readRes = await j("GET", `/api/conversations/${agentId}/messages`, {
    token,
    base: sharedBase,
  });
  step(
    "shared chat read",
    readRes.status === 200 && Array.isArray(readRes.data?.messages),
    `status=${readRes.status} msgs=${readRes.data?.messages?.length}`,
  );

  // 5. Wait for dedicated container ready (bridge/web_ui + running), bounded ~5min
  let ready = null;
  const deadline = Date.now() + 5 * 60 * 1000;
  let lastStatus = "?";
  while (Date.now() < deadline) {
    const det = await j("GET", `/api/v1/eliza/agents/${agentId}`, { token });
    const a = det.data?.data || det.data || {};
    lastStatus = a.status || a.execution_status || "?";
    const base = a.bridge_url || a.bridgeUrl || a.web_ui_url || a.webUiUrl;
    if (base && (!a.status || a.status === "running")) {
      ready = { base, status: a.status };
      break;
    }
    await sleep(8000);
  }
  step(
    "dedicated container ready",
    !!ready,
    ready
      ? `base=${ready.base} status=${ready.status}`
      : `timed out, lastStatus=${lastStatus}`,
  );

  // 6. Conversation import to the dedicated container (idempotent, inference-free)
  if (ready) {
    const importRes = await j("POST", `/api/conversations/${agentId}/import`, {
      token,
      base: ready.base,
      body: {
        messages: [
          { role: "user", text: "Hello, reply with the single word: working" },
        ],
      },
    });
    step(
      "conversation import",
      importRes.status === 200,
      `status=${importRes.status} inserted=${importRes.data?.inserted} alreadyPopulated=${importRes.data?.alreadyPopulated}`,
    );
    // dedicated chat works?
    const ded = await j("POST", `/api/conversations/${agentId}/messages`, {
      token,
      base: ready.base,
      body: { text: "Say: dedicated-ok" },
    });
    step(
      "dedicated chat",
      ded.status === 200 || ded.status === 201,
      `status=${ded.status} reply="${String(ded.data?.text || "").slice(0, 40)}"`,
    );
  }

  // 7. Deprovision (delete container) + poll to gone
  const delRes = await j("DELETE", `/api/v1/eliza/agents/${agentId}`, {
    token,
  });
  const jobId = delRes.data?.data?.jobId || delRes.data?.jobId;
  step(
    "delete agent",
    delRes.status >= 200 && delRes.status < 300,
    `status=${delRes.status} jobId=${jobId}`,
  );
  // poll until 404 (gone), bounded ~3min
  let gone = false;
  const dl2 = Date.now() + 3 * 60 * 1000;
  while (Date.now() < dl2) {
    const det = await j("GET", `/api/v1/eliza/agents/${agentId}`, { token });
    if (det.status === 404) {
      gone = true;
      break;
    }
    await sleep(6000);
  }
  step(
    "container deprovisioned (404)",
    gone,
    gone ? "agent gone" : "still present after 3min",
  );

  done();
}

function done() {
  const pass = results.filter((r) => r.ok).length;
  log(`\n=== REAL CLOUD FLOW: ${pass}/${results.length} passed ===`);
  for (const r of results.filter((x) => !x.ok))
    log(`  FAIL: ${r.name} — ${r.detail}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
main().catch((e) => {
  log("FATAL:", e.message);
  process.exit(2);
});
