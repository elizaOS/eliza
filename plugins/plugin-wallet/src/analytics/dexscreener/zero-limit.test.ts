/**
 * An explicit DexScreener list limit of 0 is an empty page. `limit || 10`
 * and `limit ? slice : slice(0, 20)` used to substitute the default page.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("DexScreener explicit empty pages", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats a trending limit of 0 as an empty page", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/token-boosts/")) {
        return json([
          { chainId: "solana", tokenAddress: "a" },
          { chainId: "solana", tokenAddress: "b" },
        ]);
      }
      return json([{ chainId: "solana", pairAddress: url }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = await DexScreenerService.start(runtime());

    const empty = await service.getTrending({ limit: 0 });
    expect(empty).toMatchObject({ success: true, data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    const one = await service.getTrending({ limit: 1 });
    expect(one.success && one.data).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a chain-pair limit of 0 as an empty page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          pairs: [
            { chainId: "solana", pairAddress: "a" },
            { chainId: "solana", pairAddress: "b" },
            { chainId: "ethereum", pairAddress: "c" },
          ],
        }),
      ),
    );
    const service = await DexScreenerService.start(runtime());

    const empty = await service.getPairsByChain({ chain: "solana", limit: 0 });
    expect(empty).toMatchObject({ success: true, data: [] });
    const one = await service.getPairsByChain({ chain: "solana", limit: 1 });
    expect(one.success && one.data?.map((pair) => pair.pairAddress)).toEqual([
      "a",
    ]);
    const all = await service.getPairsByChain({ chain: "solana" });
    expect(all.success && all.data?.map((pair) => pair.pairAddress)).toEqual([
      "a",
      "b",
    ]);
  });

  it("treats a new-pair limit of 0 as an empty page", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/token-profiles/")) {
        return json([
          { chainId: "solana", tokenAddress: "a" },
          { chainId: "solana", tokenAddress: "b" },
        ]);
      }
      return json([{ chainId: "solana", pairAddress: "pair" }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = await DexScreenerService.start(runtime());

    const empty = await service.getNewPairs({ limit: 0 });
    expect(empty).toMatchObject({ success: true, data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    const omitted = await service.getNewPairs();
    expect(omitted.success && omitted.data).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
