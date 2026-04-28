import type { AgentRuntime, PaymentEnabledRoute } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import { resolveEffectiveX402 } from "../x402-resolve.ts";

function mockRuntime(character: AgentRuntime["character"]): AgentRuntime {
  return {
    character,
  } as AgentRuntime;
}

describe("resolveEffectiveX402", () => {
  it("resolves x402: true from character defaults", () => {
    const route = {
      type: "GET",
      path: "/p/test",
      x402: true,
    } as PaymentEnabledRoute;
    const rt = mockRuntime({
      settings: {
        x402: {
          defaultPriceInCents: 50,
          defaultPaymentConfigs: ["base_usdc"],
        },
      },
    });
    expect(resolveEffectiveX402(route, rt)).toEqual({
      priceInCents: 50,
      paymentConfigs: ["base_usdc"],
    });
  });

  it("returns null for x402: true without character defaults", () => {
    const route = {
      type: "GET",
      path: "/p/x",
      x402: true,
    } as PaymentEnabledRoute;
    const rt = mockRuntime({});
    expect(resolveEffectiveX402(route, rt)).toBeNull();
  });

  it("merges partial route x402 with character defaults", () => {
    const route = {
      type: "GET",
      path: "/p/y",
      x402: { priceInCents: 25 },
    } as PaymentEnabledRoute;
    const rt = mockRuntime({
      settings: {
        x402: {
          defaultPaymentConfigs: ["solana_elizaos", "base_elizaos"],
        },
      },
    });
    expect(resolveEffectiveX402(route, rt)).toEqual({
      priceInCents: 25,
      paymentConfigs: ["solana_elizaos", "base_elizaos"],
    });
  });
});
