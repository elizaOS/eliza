// Exercises payout assets behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import {
  getPayoutTokenConfig,
  isPayoutAsset,
  isUsdcPayoutNetwork,
  PAYOUT_ASSETS,
  USDC_DECIMALS,
  USDC_PAYOUT_NETWORKS,
  USDC_TOKEN_ADDRESSES,
} from "./payout-assets";

describe("payout assets", () => {
  test("PAYOUT_ASSETS is eliza + usdc", () => {
    expect([...PAYOUT_ASSETS].sort()).toEqual(["eliza", "usdc"]);
  });

  test("isPayoutAsset guards", () => {
    expect(isPayoutAsset("usdc")).toBe(true);
    expect(isPayoutAsset("eliza")).toBe(true);
    expect(isPayoutAsset("btc")).toBe(false);
  });

  test("USDC is offered on Solana + Base only", () => {
    expect([...USDC_PAYOUT_NETWORKS].sort()).toEqual(["base", "solana"]);
    expect(isUsdcPayoutNetwork("solana")).toBe(true);
    expect(isUsdcPayoutNetwork("base")).toBe(true);
    expect(isUsdcPayoutNetwork("ethereum")).toBe(false);
    expect(isUsdcPayoutNetwork("bnb")).toBe(false);
  });

  test("USDC uses 6 decimals; resolver returns a USDC mint for the mode", () => {
    // NODE_ENV=test ⇒ testnet mode, so the resolver returns testnet USDC; the
    // mode-independent facts are the 6-decimal + USDC symbol.
    const base = getPayoutTokenConfig("base", "usdc");
    expect(base.decimals).toBe(USDC_DECIMALS);
    expect(base.decimals).toBe(6);
    expect(base.symbol).toBe("USDC");
    expect(base.address).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const sol = getPayoutTokenConfig("solana", "usdc");
    expect(sol.decimals).toBe(6);
    expect(sol.address.length).toBeGreaterThan(30);
  });

  test("elizaOS asset keeps 9 decimals + the elizaOS token address", () => {
    const base = getPayoutTokenConfig("base", "eliza");
    expect(base.decimals).toBe(9);
    expect(base.symbol).toBe("elizaOS");
    // elizaOS token, NOT USDC.
    expect(base.address).not.toBe(USDC_TOKEN_ADDRESSES.base);
  });

  test("Base USDC address is Circle-native USDC (not a placeholder)", () => {
    expect(USDC_TOKEN_ADDRESSES.base).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(USDC_TOKEN_ADDRESSES.solana).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });

  test("a $10 USDC payout resolves to 10_000_000 base units (6 decimals)", () => {
    const cfg = getPayoutTokenConfig("base", "usdc");
    const usd = 10;
    const baseUnits = BigInt(Math.round(usd * 10 ** cfg.decimals));
    expect(baseUnits).toBe(10_000_000n);
  });
});
