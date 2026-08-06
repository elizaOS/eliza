import "dotenv/config";
import http from "node:http";
import crypto from "node:crypto";
import { verifyClawdSso } from "./verify-clawd-sso.js";

const PORT = Number(process.env.PORT ?? "8787");
const nonces = new Map<string, { nonce: string; exp: number }>();

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-payment",
  });
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return json(res, 200, { ok: true });

    if (req.method === "GET" && req.url === "/.well-known/agent.json") {
      return json(res, 200, {
        name: "CLAWD",
        registration: "https://x402.wtf/agents/clawd",
        auth: "CLAWD_AUTH_V1",
        challenge: "/api/auth/challenge",
        verify: "/api/auth/verify",
      });
    }

    if (req.method === "POST" && req.url === "/api/auth/challenge") {
      const body = await readBody(req);
      if (!body.wallet || !body.agentAsset) return json(res, 400, { ok: false, error: "wallet and agentAsset required" });
      const nonce = crypto.randomBytes(16).toString("hex");
      const exp = Math.floor(Date.now() / 1000) + 300;
      const message = `CLAWD_AUTH_V1\nDomain: x402.wtf\nWallet: ${body.wallet}\nAgentAsset: ${body.agentAsset}\nNonce: ${nonce}\nExpires: ${exp}`;
      nonces.set(`${body.wallet}:${body.agentAsset}:${nonce}`, { nonce, exp });
      return json(res, 200, { ok: true, nonce, exp, message });
    }

    if (req.method === "POST" && req.url === "/api/auth/verify") {
      const body = await readBody(req);
      const key = `${body.wallet}:${body.agentAsset}:${body.nonce}`;
      const record = nonces.get(key);
      if (!record || record.exp < Math.floor(Date.now() / 1000)) {
        return json(res, 401, { ok: false, error: "missing or expired nonce" });
      }
      const result = await verifyClawdSso({
        wallet: body.wallet,
        agentAsset: body.agentAsset,
        message: body.message,
        signature: body.signature,
      });
      nonces.delete(key);
      return json(res, 200, result);
    }

    return json(res, 404, { ok: false, error: "not found" });
  } catch (err: any) {
    return json(res, 500, { ok: false, error: String(err?.message ?? err) });
  }
});

server.listen(PORT, () => {
  console.log(`CLAWD auth SSO server listening on http://localhost:${PORT}`);
});
