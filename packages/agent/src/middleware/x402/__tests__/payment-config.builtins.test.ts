import { describe, expect, it } from "vitest";

import {
  atomicAmountForPriceInCents,
  getNetworkAssets,
  getPaymentConfig,
  registerX402Config,
  toX402Network,
} from "../payment-config.ts";

describe("payment-config built-in presets", () => {
  it("computes atomic max amount from cents (USDC 1:1)", () => {
    const cfg = getPaymentConfig("base_usdc");
    expect(atomicAmountForPriceInCents(100, cfg)).toBe("1000000");
    expect(atomicAmountForPriceInCents(1, cfg)).toBe("10000");
  });

  it("computes atomic amount for Base elizaOS via rational USD price (18 decimals)", () => {
    const cfg = getPaymentConfig("base_elizaos");
    expect(atomicAmountForPriceInCents(100, cfg)).toBe("20000000000000000000");
  });

  it("resolves USDC and elizaOS / degenAI presets", () => {
    expect(getPaymentConfig("base_usdc").network).toBe("BASE");
    expect(getPaymentConfig("solana_usdc").symbol).toBe("USDC");
    expect(getPaymentConfig("polygon_usdc").chainId).toBe("137");

    const be = getPaymentConfig("base_elizaos");
    expect(be.network).toBe("BASE");
    expect(be.symbol).toBe("elizaOS");
    expect(be.assetReference.toLowerCase()).toContain("ea17");

    const se = getPaymentConfig("solana_elizaos");
    expect(se.network).toBe("SOLANA");
    expect(se.symbol).toBe("elizaOS");

    const sd = getPaymentConfig("solana_degenai");
    expect(sd.network).toBe("SOLANA");
    expect(sd.symbol).toBe("degenai");
  });

  it("maps networks for x402scan", () => {
    expect(toX402Network("BASE")).toBe("base");
    expect(toX402Network("SOLANA")).toBe("solana");
    expect(toX402Network("POLYGON")).toBe("polygon");
  });

  it("lists Solana assets including elizaOS and degenai", () => {
    const assets = getNetworkAssets("SOLANA");
    expect(assets).toContain("USDC");
    expect(assets).toContain("elizaOS");
    expect(assets).toContain("degenai");
  });

  it("lists Base assets including elizaOS", () => {
    const assets = getNetworkAssets("BASE");
    expect(assets).toContain("USDC");
    expect(assets).toContain("elizaOS");
  });

  it("allows registerX402Config for custom names", () => {
    const name = `test_custom_x402_${Date.now()}`;
    registerX402Config(name, {
      network: "BASE",
      assetNamespace: "erc20",
      assetReference: "0x0000000000000000000000000000000000000001",
      paymentAddress: "0x066E94e1200aa765d0A6392777D543Aa6Dea606C",
      symbol: "TEST",
      chainId: "8453",
    });
    expect(getPaymentConfig(name).symbol).toBe("TEST");
  });

  it("registerX402Config throws on duplicate custom name without override", () => {
    const name = `dup_custom_x402_${Date.now()}`;
    const def = {
      network: "BASE" as const,
      assetNamespace: "erc20" as const,
      assetReference: "0x0000000000000000000000000000000000000001",
      paymentAddress: "0x066E94e1200aa765d0A6392777D543Aa6Dea606C",
      symbol: "A",
      chainId: "8453",
    };
    registerX402Config(name, def);
    expect(() => registerX402Config(name, { ...def, symbol: "B" })).toThrow(
      /already registered/,
    );
    registerX402Config(name, { ...def, symbol: "B" }, { override: true });
    expect(getPaymentConfig(name).symbol).toBe("B");
  });

  it("registerX402Config throws on duplicate agent-scoped key without override", () => {
    const aid = `ag-${Date.now()}`;
    const name = `scoped_dup_${Date.now()}`;
    const def = {
      network: "BASE" as const,
      assetNamespace: "erc20" as const,
      assetReference: "0x0000000000000000000000000000000000000001",
      paymentAddress: "0x066E94e1200aa765d0A6392777D543Aa6Dea606C",
      symbol: "A",
      chainId: "8453",
    };
    registerX402Config(name, def, { agentId: aid });
    expect(() =>
      registerX402Config(name, { ...def, symbol: "B" }, { agentId: aid }),
    ).toThrow(/already registered/);
  });
});
