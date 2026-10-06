/**
 * An explicit token-info list limit of 0 asks DexScreener for no rows.
 * `Math.max(1, limit)` turned that into a one-row lookup.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createDexScreenerTokenInfoProvider } from "./providers.js";

function runtime(service: Record<string, unknown>): IAgentRuntime {
  return {
    getService: () => service,
  } as unknown as IAgentRuntime;
}

function context(
  service: Record<string, unknown>,
  params: {
    subaction: "trending" | "new_pairs" | "chain_pairs";
    limit?: number;
    chain?: string;
  },
) {
  return {
    runtime: runtime(service),
    message: { content: { text: "" } } as unknown as Memory,
    params,
  };
}

describe("DexScreener token info explicit empty page", () => {
  it("asks for no trending pairs when the limit is 0", async () => {
    const getTrending = vi.fn(async () => ({ success: true, data: [] }));
    const provider = createDexScreenerTokenInfoProvider();
    const service = { search: vi.fn(), getTrending };

    const empty = await provider.execute(
      context(service, { subaction: "trending", limit: 0 }),
    );
    expect(empty.success).toBe(true);
    expect(getTrending).toHaveBeenCalledWith({ timeframe: "24h", limit: 0 });

    await provider.execute(context(service, { subaction: "trending" }));
    expect(getTrending).toHaveBeenLastCalledWith({
      timeframe: "24h",
      limit: 10,
    });
  });

  it("asks for no new or chain pairs when the limit is 0", async () => {
    const getNewPairs = vi.fn(async () => ({ success: true, data: [] }));
    const getPairsByChain = vi.fn(async () => ({ success: true, data: [] }));
    const provider = createDexScreenerTokenInfoProvider();
    const service = { search: vi.fn(), getNewPairs, getPairsByChain };

    await provider.execute(
      context(service, { subaction: "new_pairs", limit: 0 }),
    );
    expect(getNewPairs).toHaveBeenCalledWith({ chain: undefined, limit: 0 });

    await provider.execute(
      context(service, { subaction: "chain_pairs", chain: "solana", limit: 0 }),
    );
    expect(getPairsByChain).toHaveBeenCalledWith({
      chain: "solana",
      sortBy: "volume",
      limit: 0,
    });
  });
});
