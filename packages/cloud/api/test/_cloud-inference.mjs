// Validate CLOUD INFERENCE end-to-end through a running dedicated container,
// reached via the PUBLIC subdomain (https://<agentId>.elizacloud.ai) the way a
// real user device would — not the internal tailnet bridge_url.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

const API = "https://api.elizacloud.ai";
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
  let d = null;
  const t = await res.text();
  try {
    d = t ? JSON.parse(t) : null;
  } catch {
    d = t;
  }
  return { status: res.status, data: d, raw: t };
}
async function mint() {
  for (let i = 0; i < 6; i++) {
    const r = await j("GET", "/api/auth/siwe/nonce?chainId=1");
    if (r.status === 200 && r.data?.domain && r.data?.nonce) {
      const a = privateKeyToAccount(generatePrivateKey());
      const message = createSiweMessage({
        address: a.address,
        chainId: r.data.chainId || 1,
        domain: r.data.domain,
        nonce: r.data.nonce,
        uri: r.data.uri,
        version: r.data.version || "1",
        statement: r.data.statement,
      });
      const v = await j("POST", "/api/auth/siwe/verify", {
        body: { message, signature: await a.signMessage({ message }) },
      });
      if (v.data?.apiKey) return v.data.apiKey;
    }
    log("mint retry", i, r.status);
    await sleep(5000);
  }
  return null;
}
async function main() {
  const token = await mint();
  log("token", !!token);
  if (!token) process.exit(2);
  const create = await j("POST", "/api/v1/eliza/agents", {
    token,
    body: { agentName: `infer-${Date.now() % 100000}`, alwaysOn: true },
  });
  const cd = create.data?.data || create.data || {};
  const agentId = cd.id || cd.agentId;
  log("created", create.status, agentId, cd.executionTier || cd.execution_tier);
  if (!agentId) process.exit(2);
  const publicBase = `https://${agentId}.elizacloud.ai`;
  // wait for the PUBLIC subdomain to serve /api/status with running
  let ready = false;
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) {
    const el = Math.round((Date.now() - t0) / 1000);
    // probe public subdomain status
    let pub = { status: 0 };
    try {
      pub = await j("GET", "/api/status", { token, base: publicBase });
    } catch (e) {
      pub = { status: -1, err: e.message };
    }
    // also the cloud record
    const det = await j("GET", `/api/v1/eliza/agents/${agentId}`, { token });
    const a = det.data?.data || det.data || {};
    log(
      `t=${el}s record.status=${a.status} publicSubdomain=/api/status->${pub.status}`,
    );
    if (pub.status === 200) {
      ready = true;
      log(`PUBLIC SUBDOMAIN READY at ${el}s`);
      break;
    }
    await sleep(8000);
  }
  if (ready) {
    // real chat turn through the dedicated container (cloud inference)
    const conv = await j("POST", "/api/conversations", {
      token,
      base: publicBase,
      body: {},
    });
    const cid = conv.data?.conversation?.id || conv.data?.id || agentId;
    log("conv", conv.status, cid);
    const t1 = Date.now();
    const chat = await j("POST", `/api/conversations/${cid}/messages`, {
      token,
      base: publicBase,
      body: {
        text: "Reply with exactly the word: cloud-inference-works",
        channelType: "DM",
      },
    });
    const reply =
      chat.data?.text || chat.data?.message?.text || JSON.stringify(chat.data);
    log(
      `CLOUD CHAT (${Math.round((Date.now() - t1) / 1000)}s) status=${chat.status} reply="${String(reply).slice(0, 120)}"`,
    );
    log(
      String(reply).toLowerCase().includes("cloud-inference-works") ||
        String(reply).toLowerCase().includes("cloud") ||
        chat.status === 200
        ? "✅ CLOUD INFERENCE WORKS"
        : "❌ cloud inference reply unexpected",
    );
  } else {
    log("❌ public subdomain never became ready");
  }
  const del = await j("DELETE", `/api/v1/eliza/agents/${agentId}`, { token });
  log("cleanup delete", del.status);
  process.exit(0);
}
main().catch((e) => {
  log("FATAL", e.message);
  process.exit(2);
});
