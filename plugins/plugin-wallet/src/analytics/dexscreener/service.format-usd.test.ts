/**
 * DexScreener token text uses formatUsdValue for 24h volume and liquidity.
 * A value just under a suffix boundary must not render as $1000.00K.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { expect, it } from "vitest";
import { DexScreenerService } from "./service";

it("promotes a DexScreener USD value that rounds across a suffix boundary", async () => {
  const service = await DexScreenerService.start({
    getSetting(key: string) {
      if (key === "DEXSCREENER_API_URL") return "https://dex.example.test";
      return undefined;
    },
  } as unknown as IAgentRuntime);
  expect(service.formatUsdValue(1_500)).toBe("$1.50K");
  expect(service.formatUsdValue(2_500_000)).toBe("$2.50M");
  expect(service.formatUsdValue(999.994)).toBe("$999.99");
  expect(service.formatUsdValue(999_999)).toBe("$1.00M");
  expect(service.formatUsdValue(999.999)).toBe("$1.00K");
  expect(service.formatUsdValue(1_500_000_000)).toBe("$1.50B");
  expect(service.formatUsdValue(999_999_999)).toBe("$1.00B");
});
