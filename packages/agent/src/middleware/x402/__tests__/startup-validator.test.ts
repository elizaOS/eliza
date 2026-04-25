import type { Character, Route } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerX402Config } from "../payment-config.ts";
import { validateX402Startup } from "../startup-validator.ts";

describe("validateX402Startup", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("accepts route with x402: true when character defaults exist", () => {
    const routes: Route[] = [
      {
        type: "GET",
        path: "/plugin/paid",
        x402: true,
        handler: async () => {},
      } as Route,
    ];
    const character: Character = {
      settings: {
        x402: {
          defaultPriceInCents: 10,
          defaultPaymentConfigs: ["base_usdc"],
        },
      },
    };
    const result = validateX402Startup(routes, character);
    expect(result.valid).toBe(true);
  });

  it("errors when x402: true and character defaults missing", () => {
    const routes: Route[] = [
      {
        type: "GET",
        path: "/plugin/paid",
        x402: true,
        handler: async () => {},
      } as Route,
    ];
    const result = validateX402Startup(routes, {});
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("defaultPriceInCents"))).toBe(
      true,
    );
  });

  it("rejects bundled dev payout when NODE_ENV is production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const routes: Route[] = [
      {
        type: "GET",
        path: "/paid",
        x402: { priceInCents: 50, paymentConfigs: ["base_usdc"] },
        handler: async () => {},
      } as Route,
    ];
    const result = validateX402Startup(routes, {});
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("bundled dev example"))).toBe(
      true,
    );
  });

  it("accepts agent-scoped payment config when agentId option matches", () => {
    const aid = `test-agent-${Date.now()}`;
    const name = `scoped_token_${Date.now()}`;
    registerX402Config(
      name,
      {
        network: "BASE",
        assetNamespace: "erc20",
        assetReference: "0x0000000000000000000000000000000000000001",
        paymentAddress: "0x066E94e1200aa765d0A6392777D543Aa6Dea606C",
        symbol: "TEST",
        chainId: "8453",
      },
      { agentId: aid },
    );
    const routes: Route[] = [
      {
        type: "GET",
        path: "/p/x",
        x402: { priceInCents: 1, paymentConfigs: [name] },
        handler: async () => {},
      } as Route,
    ];
    expect(validateX402Startup(routes, {}).valid).toBe(false);
    expect(validateX402Startup(routes, {}, { agentId: aid }).valid).toBe(true);
  });
});
