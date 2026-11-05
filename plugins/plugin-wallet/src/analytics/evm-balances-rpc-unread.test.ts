/**
 * A direct-RPC token read that failed must not be reported as a complete
 * inventory. The RPC fallback path queries the trade ledger's known token
 * addresses with `Promise.allSettled` and kept only the fulfilled results, so a
 * rate-limited or failed `balanceOf` call dropped that holding with `error:
 * null` — the same silent omission the Alchemy path reports as
 * "Token metadata unavailable for N of M tokens".
 */
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvmProviderKeyset } from "./evm-balances.ts";

vi.mock("./dex-prices.ts", () => ({
  DEXSCREENER_CHAIN_MAP: {},
  DEXPAPRIKA_CHAIN_MAP: {},
  WRAPPED_NATIVE: {},
  DEX_PRICE_TIMEOUT_MS: 1,
  fetchDexScreenerPrices: async () => new Map(),
  fetchDexPaprikaPrices: async () => new Map(),
  fetchDexPrices: async () => new Map(),
  computeValueUsd: () => "0",
}));

const { fetchResolvedEvmBalances } = await import("./evm-balances.ts");

const WALLET = "0x1111111111111111111111111111111111111111";
const HELD = "0x2222222222222222222222222222222222222222";
const UNREAD = "0x3333333333333333333333333333333333333333";
const EMPTY = "0x4444444444444444444444444444444444444444";
const BALANCE_OF = "0x70a08231";

type TokenReply = {
  status: number;
  result?: string;
  error?: { message: string };
};

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function listen(replies: Record<string, TokenReply>): Promise<string> {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as {
      method: string;
      params?: Array<{ to?: string; data?: string }>;
    };
    if (request.method === "eth_getBalance") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xde0b6b3a7640000" }),
      );
      return;
    }
    const call = request.params?.[0];
    const to = call?.to?.toLowerCase() ?? "";
    if (request.method === "eth_call" && call?.data?.startsWith(BALANCE_OF)) {
      const reply = replies[to];
      if (reply && reply.status !== 200) {
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            reply.error ? { jsonrpc: "2.0", id: 1, error: reply.error } : {},
          ),
        );
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: reply?.result ?? "0x0",
        }),
      );
      return;
    }
    // symbol()/decimals() are optional: an empty result keeps the defaults.
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }));
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function keysFor(rpcUrl: string): EvmProviderKeyset {
  return {
    alchemyKey: null,
    ankrKey: null,
    cloudManagedAccess: false,
    bscRpcUrls: [],
    ethereumRpcUrls: [rpcUrl],
    baseRpcUrls: [],
    avaxRpcUrls: [],
    nodeRealBscRpcUrl: null,
    quickNodeBscRpcUrl: null,
    bscRpcUrl: null,
    ethereumRpcUrl: rpcUrl,
    baseRpcUrl: null,
    avaxRpcUrl: null,
  };
}

describe("direct-RPC EVM token reads", () => {
  it("reports a held token whose balance read failed instead of a complete inventory", async () => {
    const rpcUrl = await listen({
      [HELD]: { status: 200, result: `0x${(100n).toString(16)}` },
      [UNREAD]: { status: 429, error: { message: "rate limited" } },
      [EMPTY]: { status: 200, result: "0x0" },
    });

    const chains = await fetchResolvedEvmBalances(WALLET, keysFor(rpcUrl), [
      HELD,
      UNREAD,
      EMPTY,
    ]);
    const ethereum = chains.find((chain) => chain.chainId === 1);

    expect(ethereum?.tokens.map((token) => token.contractAddress)).toEqual([
      HELD,
    ]);
    expect(ethereum?.error).toBe("Token balance unavailable for 1 of 3 tokens");
  });

  it("keeps a zero balance out of the inventory without reporting a failure", async () => {
    const rpcUrl = await listen({
      [EMPTY]: { status: 200, result: "0x0" },
    });

    const chains = await fetchResolvedEvmBalances(WALLET, keysFor(rpcUrl), [
      EMPTY,
    ]);
    const ethereum = chains.find((chain) => chain.chainId === 1);

    expect(ethereum?.tokens).toEqual([]);
    expect(ethereum?.error).toBeNull();
  });
});
