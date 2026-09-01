/**
 * Solana RPC Proxy
 *
 * Proxies JSON-RPC requests to a Helius-backed Solana RPC endpoint.
 * The cloud injects its own Helius API key server-side.
 * Deducts credits per RPC call.
 *
 * Usage: POST /api/v1/proxy/solana-rpc
 *        Body: JSON-RPC 2.0 request (or batch)
 */

import { Hono } from "hono";
import {
  applyLegacyProxyQueryApiKey,
  executePaidProxyWithCombinedAdmission,
} from "@/api-app/lib/legacy-proxy-combined-admission";
import {
  solanaRpcConfig,
  solanaRpcHandler,
} from "@/lib/services/proxy/services/solana-rpc";
import type { ProxyRequestBody } from "@/lib/services/proxy/types";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  // Support auth via query param for @solana/web3.js Connection clients that
  // cannot set custom headers.
  const headers = applyLegacyProxyQueryApiKey(c);

  let body: ProxyRequestBody;
  try {
    body = (await c.req.json()) as ProxyRequestBody;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const request = new Request(c.req.url, {
    method: "POST",
    headers,
  });

  return executePaidProxyWithCombinedAdmission(
    c,
    solanaRpcConfig,
    solanaRpcHandler,
    request,
    body,
  );
});

export default app;
