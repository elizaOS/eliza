/**
 * Trending and "new pairs" are proxy views: DexScreener has no such endpoint,
 * so the service expands one ranking page into per-token pair lookups.
 * A failed lookup used to resolve to `null` and be filtered out, so when every
 * lookup failed the call still answered `{ success: true, data: [] }` — the
 * caller could not tell "DexScreener is down" from "nothing is trending" and
 * rendered an empty, successful list.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, expect, it } from "vitest";
import { DexScreenerService } from "./service";

function runtime(): IAgentRuntime {
  return {
    getSetting(key: string) {
      if (key === "DEXSCREENER_API_URL") return "https://dex.example.test";
      if (key === "DEXSCREENER_RATE_LIMIT_DELAY") return 0;
      return undefined;
    },
  } as unknown as IAgentRuntime;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type Responder = (url: string) => Response;

function stubFetch(respond: Responder): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    return respond(url);
  }) as typeof fetch;
  return urls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const boosted = [
  {
    chainId: "solana",
    tokenAddress: "So11111111111111111111111111111111111111112",
  },
  {
    chainId: "solana",
    tokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
];

const profiles = [
  {
    chainId: "solana",
    tokenAddress: "So11111111111111111111111111111111111111112",
  },
  {
    chainId: "solana",
    tokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
];

function pair(address: string, symbol: string) {
  return {
    chainId: "solana",
    dexId: "raydium",
    pairAddress: `pair-${symbol}`,
    baseToken: { address, name: symbol, symbol },
    quoteToken: { address: "USDC", name: "USD Coin", symbol: "USDC" },
    priceUsd: "1",
    liquidity: { usd: 1000 },
    volume: { h24: 10 },
    priceChange: { h24: 1 },
    labels: [],
  };
}

it("reports a failed trending page instead of an empty list", async () => {
  const urls = stubFetch((url) => {
    if (url.includes("/token-boosts/top/v1")) return json(boosted);
    return json({ message: "upstream unavailable" }, 503);
  });
  const service = await DexScreenerService.start(runtime());

  const result = await service.getTrending({ limit: 2 });

  expect(result.success).toBe(false);
  expect(result.error).toMatch(/HTTP 503|unavailable/);
  expect(urls.filter((u) => u.includes("/tokens/v1/"))).toHaveLength(2);
});

it("reports a failed new-pairs page instead of an empty list", async () => {
  stubFetch((url) => {
    if (url.includes("/token-profiles/latest/v1")) return json(profiles);
    return json({ message: "upstream unavailable" }, 503);
  });
  const service = await DexScreenerService.start(runtime());

  const result = await service.getNewPairs({ limit: 2 });

  expect(result.success).toBe(false);
  expect(result.error).toMatch(/HTTP 503|unavailable/);
});

it("returns the pairs that resolved when only some lookups fail", async () => {
  stubFetch((url) => {
    if (url.includes("/token-boosts/top/v1")) return json(boosted);
    if (url.endsWith(boosted[0].tokenAddress))
      return json([pair(boosted[0].tokenAddress, "SOL")]);
    return json({ message: "upstream unavailable" }, 503);
  });
  const service = await DexScreenerService.start(runtime());

  const result = await service.getTrending({ limit: 2 });

  expect(result.success).toBe(true);
  expect(result.data?.map((p) => p.pairAddress)).toEqual(["pair-SOL"]);
});

it("keeps an empty boosted page a successful empty list", async () => {
  stubFetch(() => json([]));
  const service = await DexScreenerService.start(runtime());

  await expect(service.getTrending({ limit: 2 })).resolves.toEqual({
    success: true,
    data: [],
  });
});
