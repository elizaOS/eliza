// Mirrors the REAL app onboarding (selectOrProvisionCloudAgent): create agent
// with alwaysOn:true (what createCloudCompatAgent always sends), then — WITHOUT a
// separate provision call — poll the agent detail for dedicated readiness while
// continuously probing the shared-chat endpoint, to learn the ground truth:
//   (1) can the user chat immediately while the container boots? (the #8810 UX)
//   (2) how long does the dedicated container actually take?
//   (3) does the handoff readiness gate (bridge/web_ui + running) ever fire?
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

const API = process.env.CLOUD_API || "https://api.elizacloud.ai";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(method, path, { token, body, base } = {}) {
  const res = await fetch((base || API) + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const t = await res.text();
  try {
    data = t ? JSON.parse(t) : null;
  } catch {
    data = t;
  }
  return { status: res.status, data };
}
async function main() {
  let n = null;
  for (let i = 0; i < 5; i++) {
    const r = await j("GET", "/api/auth/siwe/nonce?chainId=1");
    if (r.status === 200 && r.data?.domain && r.data?.nonce) {
      n = r.data;
      break;
    }
    log("nonce retry", i, r.status, JSON.stringify(r.data).slice(0, 60));
    await sleep(4000);
  }
  if (!n) {
    log("FATAL no nonce after retries");
    process.exit(2);
  }
  const acct = privateKeyToAccount(generatePrivateKey());
  const message = createSiweMessage({
    address: acct.address,
    chainId: n.chainId || 1,
    domain: n.domain,
    nonce: n.nonce,
    uri: n.uri,
    version: n.version || "1",
    statement: n.statement,
  });
  const token = (
    await j("POST", "/api/auth/siwe/verify", {
      body: { message, signature: await acct.signMessage({ message }) },
    })
  ).data?.apiKey;
  log("token minted", !!token);
  const create = await j("POST", "/api/v1/eliza/agents", {
    token,
    body: { agentName: `onb-${acct.address.slice(2, 8)}`, alwaysOn: true },
  });
  const cd = create.data?.data || create.data || {};
  const agentId = cd.id || cd.agentId;
  log(
    "created",
    create.status,
    "id",
    agentId,
    "tier",
    cd.executionTier || cd.execution_tier,
    "status",
    cd.status,
  );
  if (!agentId) {
    log("no agentId, abort");
    return cleanup(token, agentId);
  }
  const sharedBase = `${API}/api/v1/eliza/agents/${agentId}`;
  let firstChatOk = null,
    readyAt = null;
  const t0 = Date.now();
  for (let i = 0; i < 80; i++) {
    // ~10 min at ~8s
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const det = await j("GET", `/api/v1/eliza/agents/${agentId}`, { token });
    const a = det.data?.data || det.data || {};
    const base = a.bridge_url || a.bridgeUrl || a.web_ui_url || a.webUiUrl;
    const st = a.status || a.execution_status;
    // probe shared chat
    const chat = await j("POST", `/api/conversations/${agentId}/messages`, {
      token,
      base: sharedBase,
      body: { text: "ping" },
    });
    if (
      firstChatOk === null &&
      chat.status === 200 &&
      typeof chat.data?.text === "string"
    ) {
      firstChatOk = elapsed;
      log(`SHARED CHAT WORKS at t=${elapsed}s`);
    }
    log(
      `t=${elapsed}s status=${st} base=${base ? "Y" : "N"} sharedChat=${chat.status}${chat.status !== 200 ? `(${String(chat.data?.error || chat.data?.text || "").slice(0, 30)})` : ""}`,
    );
    if (base && (!st || st === "running")) {
      readyAt = elapsed;
      log(`DEDICATED READY at t=${elapsed}s base=${base}`);
      break;
    }
    await sleep(8000);
  }
  log("\n=== SUMMARY ===");
  log(
    "shared chat first worked at:",
    firstChatOk === null
      ? "NEVER (broken: cannot chat while booting)"
      : `${firstChatOk}s`,
  );
  log(
    "dedicated container ready at:",
    readyAt === null ? "TIMED OUT (>10min)" : `${readyAt}s`,
  );
  await cleanup(token, agentId);
}
async function cleanup(token, agentId) {
  if (token && agentId) {
    const d = await j("DELETE", `/api/v1/eliza/agents/${agentId}`, { token });
    log("cleanup delete", d.status);
  }
  process.exit(0);
}
main().catch((e) => {
  log("FATAL", e.message);
  process.exit(2);
});
