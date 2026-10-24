/**
 * A token whose Alchemy metadata request fails has an unknown balance. The
 * chain must say so (an `error`) instead of returning a complete-looking
 * inventory without it, which the balance watcher would read as a drop.
 * Runs the real fetchResolvedEvmBalances; only the HTTP boundary is replaced.
 */
import { afterEach, expect, it, vi } from "vitest";
import {
  type EvmProviderKeyset,
  fetchResolvedEvmBalances,
} from "./evm-balances.ts";

const OWNER = "0x1111111111111111111111111111111111111111";
const TOKEN_OK = "0x00000000000000000000000000000000000000aa";
const TOKEN_FAILS = "0x00000000000000000000000000000000000000bb";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("reports a chain error when a held token's metadata cannot be read", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes(".g.alchemy.com/v2/")) {
        return Response.json({ pairs: [] });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method: string;
        params: string[];
      };
      if (body.method === "eth_getBalance") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: "0x0" });
      }
      if (body.method === "alchemy_getTokenBalances") {
        return Response.json({
          jsonrpc: "2.0",
          id: 2,
          result: {
            tokenBalances: [
              { contractAddress: TOKEN_OK, tokenBalance: "0x0de0b6b3a7640000" },
              {
                contractAddress: TOKEN_FAILS,
                tokenBalance: "0x0de0b6b3a7640000",
              },
            ],
          },
        });
      }
      if (body.params[0] === TOKEN_FAILS) {
        return new Response("Too Many Requests", { status: 429 });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: 3,
        result: { symbol: "OK", name: "Ok Token", decimals: 18, logo: "" },
      });
    }),
  );

  const keys = {
    alchemyKey: "test-key",
    ankrKey: null,
    cloudManagedAccess: false,
    bscRpcUrls: [],
    ethereumRpcUrls: [],
    baseRpcUrls: [],
    avaxRpcUrls: [],
    nodeRealBscRpcUrl: null,
    quickNodeBscRpcUrl: null,
    bscRpcUrl: null,
    ethereumRpcUrl: null,
    baseRpcUrl: null,
    avaxRpcUrl: null,
  } satisfies EvmProviderKeyset;
  const chains = await fetchResolvedEvmBalances(OWNER, keys);
  const alchemyChains = chains.filter((chain) =>
    chain.tokens.some((token) => token.contractAddress === TOKEN_OK),
  );

  expect(alchemyChains.length).toBeGreaterThan(0);
  for (const chain of alchemyChains) {
    expect(chain.error).toBe("Token metadata unavailable for 1 of 2 tokens");
  }
});
