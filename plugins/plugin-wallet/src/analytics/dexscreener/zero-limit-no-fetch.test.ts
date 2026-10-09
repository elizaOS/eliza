/**
 * An explicit DexScreener list limit of 0 is an empty page and must not
 * fall through to the default slice (`limit || 10` / `limit ? slice : 20`).
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

const calls: string[] = [];
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  calls.length = 0;
});

it("does not call DexScreener when a list limit is 0", async () => {
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const service = await DexScreenerService.start(runtime());

  await expect(service.getTrending({ limit: 0 })).resolves.toEqual({
    success: true,
    data: [],
  });
  await expect(service.getNewPairs({ limit: 0 })).resolves.toEqual({
    success: true,
    data: [],
  });
  await expect(
    service.getPairsByChain({ chain: "solana", limit: 0 }),
  ).resolves.toEqual({ success: true, data: [] });
  expect(calls).toEqual([]);
});
