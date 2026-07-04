// Exercises cloud API test mint key behavior with deterministic Worker route fixtures.
import { writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

const j = async (m, p, b) => {
  const r = await fetch(`https://api.elizacloud.ai${p}`, {
    method: m,
    headers: { "content-type": "application/json" },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { s: r.status, d: await r.json().catch(() => null) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = null;
for (let i = 0; i < 12; i++) {
  const r = await j("GET", "/api/auth/siwe/nonce?chainId=1");
  if (r.s === 200 && r.d?.domain && r.d?.nonce) {
    n = r.d;
    break;
  }
  console.error("nonce retry", i, r.s);
  await sleep(8000);
}
if (!n) {
  console.error("FAIL no nonce");
  process.exit(1);
}
const a = privateKeyToAccount(generatePrivateKey());
const msg = createSiweMessage({
  address: a.address,
  chainId: n.chainId || 1,
  domain: n.domain,
  nonce: n.nonce,
  uri: n.uri,
  version: n.version || "1",
  statement: n.statement,
});
const v = await j("POST", "/api/auth/siwe/verify", {
  message: msg,
  signature: await a.signMessage({ message: msg }),
});
if (v.d?.apiKey) {
  writeFileSync("/tmp/cloud-validation/key.txt", v.d.apiKey);
  console.error("KEY_OK len", v.d.apiKey.length);
} else {
  console.error("FAIL verify", v.s, JSON.stringify(v.d).slice(0, 80));
  process.exit(1);
}
