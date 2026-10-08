/**
 * Token text uses formatPrice for pair prices. A price just under $1 must
 * not render as 1.0000, and a price just under $0.01 must not render as
 * 0.01000000.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { expect, it } from "vitest";
import { DexScreenerService } from "./service";

it("promotes a DexScreener price that rounds across a decimal tier", async () => {
  const service = await DexScreenerService.start({
    getSetting(key: string) {
      if (key === "DEXSCREENER_API_URL") return "https://dex.example.test";
      return undefined;
    },
  } as unknown as IAgentRuntime);
  expect(service.formatPrice(1.5)).toBe("1.50");
  expect(service.formatPrice(0.5)).toBe("0.5000");
  expect(service.formatPrice(0.009)).toBe("0.00900000");
  expect(service.formatPrice(0.99994)).toBe("0.9999");
  expect(service.formatPrice(0.99996)).toBe("1.00");
  expect(service.formatPrice(0.009999996)).toBe("0.0100");
});
