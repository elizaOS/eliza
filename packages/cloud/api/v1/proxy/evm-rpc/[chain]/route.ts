/**
 * EVM RPC Proxy
 *
 * Proxies JSON-RPC requests to an Alchemy-backed EVM RPC endpoint.
 * The cloud injects its own Alchemy API key server-side and routes
 * to the correct Alchemy network based on the chain parameter.
 *
 * Usage: POST /api/v1/proxy/evm-rpc/mainnet
 *        POST /api/v1/proxy/evm-rpc/base
 *        Body: JSON-RPC 2.0 request (or batch)
 */

import { Hono } from "hono";
import { executeGuardedPaidProxyWithPreflight } from "@/api-app/lib/guarded-paid-proxy";
import {
  rpcConfigForChain,
  rpcHandlerForChain,
  SUPPORTED_RPC_CHAINS,
} from "@/lib/services/proxy/services/rpc";
import type { ProxyRequestBody } from "@/lib/services/proxy/types";
import type { AppEnv } from "@/types/cloud-worker-env";

const LEGACY_CHAIN_ALIASES: Record<
  string,
  { chain: string; network?: "mainnet" | "testnet" }
> = {
  mainnet: { chain: "ethereum", network: "mainnet" },
  sepolia: { chain: "ethereum", network: "testnet" },
  polygon: { chain: "polygon", network: "mainnet" },
  polygonAmoy: { chain: "polygon", network: "testnet" },
  arbitrum: { chain: "arbitrum", network: "mainnet" },
  arbitrumSepolia: { chain: "arbitrum", network: "testnet" },
  optimism: { chain: "optimism", network: "mainnet" },
  optimismSepolia: { chain: "optimism", network: "testnet" },
  base: { chain: "base", network: "mainnet" },
  baseSepolia: { chain: "base", network: "testnet" },
  zksync: { chain: "zksync", network: "mainnet" },
  avalanche: { chain: "avalanche", network: "mainnet" },
};

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  const legacyChain = c.req.param("chain");
  // Support auth via query param for clients that cannot set custom headers.
  const headers = new Headers(c.req.raw.headers);
  const queryApiKey = c.req.query("api_key");
  if (
    queryApiKey &&
    !c.req.header("authorization") &&
    !c.req.header("X-API-Key")
  ) {
    headers.set("authorization", `Bearer ${queryApiKey}`);
  }
  const target = legacyChain
    ? (LEGACY_CHAIN_ALIASES[legacyChain] ?? { chain: legacyChain })
    : undefined;
  const url = new URL(c.req.url);
  if (target?.network && !url.searchParams.has("network")) {
    url.searchParams.set("network", target.network);
  }
  const request = new Request(url, {
    method: "POST",
    headers,
  });
  return executeGuardedPaidProxyWithPreflight(
    c,
    async () => {
      if (!legacyChain || !target) {
        return c.json({ error: "Missing chain parameter" }, 400);
      }
      if (!SUPPORTED_RPC_CHAINS.has(target.chain)) {
        return c.json(
          {
            error: `Unsupported chain: ${legacyChain}. Supported: ${[
              ...Object.keys(LEGACY_CHAIN_ALIASES),
              ...SUPPORTED_RPC_CHAINS,
            ]
              .filter((value, index, values) => values.indexOf(value) === index)
              .join(", ")}`,
          },
          400,
        );
      }
      let body: ProxyRequestBody;
      try {
        body = (await c.req.json()) as ProxyRequestBody;
      } catch {
        return c.json({ error: "Invalid JSON-RPC body" }, 400);
      }
      return {
        config: rpcConfigForChain(target.chain),
        work: rpcHandlerForChain(target.chain),
        body,
      };
    },
    { request },
  );
});

export default app;
