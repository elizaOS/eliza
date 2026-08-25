/**
 * Pins the redemption safety config. This data decides whether a user is warned
 * before sending tokens to a custodial address, and the vesting and fraud
 * constants gate real payouts, so the invariants worth freezing are the ones no
 * type can express: address shape and uniqueness per network, a warning that
 * always names the exchange, and vesting/fraud values staying inside sane
 * bounds. Pure module, no harness.
 */

import { describe, expect, test } from "bun:test";
import {
  checkKnownAddress,
  FRAUD_THRESHOLDS,
  getNonEOAWarning,
  getWalletRecommendation,
  KNOWN_EXCHANGE_ADDRESSES,
  POINT_SOURCE_VESTING,
  SMART_WALLET_PATTERNS,
  VESTING_CONFIG,
} from "./redemption-addresses";

const NETWORKS = Object.keys(KNOWN_EXCHANGE_ADDRESSES) as Array<
  keyof typeof KNOWN_EXCHANGE_ADDRESSES
>;
const EVM_NETWORKS = NETWORKS.filter((n) => n !== "solana");

describe("KNOWN_EXCHANGE_ADDRESSES", () => {
  test("covers every network with at least one entry", () => {
    expect(NETWORKS.length).toBeGreaterThan(0);
    for (const network of NETWORKS) {
      expect(Object.keys(KNOWN_EXCHANGE_ADDRESSES[network]).length).toBeGreaterThan(0);
    }
  });

  test("every EVM address is a lowercase 20-byte hex address", () => {
    for (const network of EVM_NETWORKS) {
      for (const address of Object.keys(KNOWN_EXCHANGE_ADDRESSES[network])) {
        expect(address).toMatch(/^0x[0-9a-f]{40}$/);
      }
    }
  });

  test("every entry names a non-blank exchange", () => {
    for (const network of NETWORKS) {
      for (const name of Object.values(KNOWN_EXCHANGE_ADDRESSES[network])) {
        expect(typeof name).toBe("string");
        expect(name.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("no address is listed twice within a network", () => {
    for (const network of NETWORKS) {
      const keys = Object.keys(KNOWN_EXCHANGE_ADDRESSES[network]);
      const lowered = keys.map((k) => k.toLowerCase());
      expect(new Set(lowered).size).toBe(keys.length);
    }
  });

  test("no address collides case-insensitively with a different label", () => {
    for (const network of NETWORKS) {
      const byLower = new Map<string, string>();
      for (const [addr, label] of Object.entries(KNOWN_EXCHANGE_ADDRESSES[network])) {
        const key = addr.toLowerCase();
        const existing = byLower.get(key);
        if (existing !== undefined) expect(existing).toBe(label);
        byLower.set(key, label);
      }
    }
  });
});

describe("checkKnownAddress", () => {
  test("flags every listed address on its own network", () => {
    for (const network of NETWORKS) {
      for (const [address, name] of Object.entries(KNOWN_EXCHANGE_ADDRESSES[network])) {
        const result = checkKnownAddress(address, network);
        expect(result.isExchange).toBe(true);
        expect(result.exchangeName).toBe(name);
      }
    }
  });

  test("a flagged address always carries a warning and a recommendation", () => {
    for (const network of NETWORKS) {
      for (const [address, name] of Object.entries(KNOWN_EXCHANGE_ADDRESSES[network])) {
        const result = checkKnownAddress(address, network);
        expect(result.warningMessage).toContain(name);
        expect((result.recommendation ?? "").length).toBeGreaterThan(0);
      }
    }
  });

  test("EVM matching ignores address casing", () => {
    for (const network of EVM_NETWORKS) {
      const [address, name] = Object.entries(KNOWN_EXCHANGE_ADDRESSES[network])[0];
      for (const variant of [address.toUpperCase().replace("0X", "0x"), address]) {
        const result = checkKnownAddress(variant, network);
        expect(result.isExchange).toBe(true);
        expect(result.exchangeName).toBe(name);
      }
    }
  });

  test("returns a clean result for an unlisted address", () => {
    for (const network of NETWORKS) {
      const result = checkKnownAddress("0x000000000000000000000000000000000000dead", network);
      expect(result).toEqual({ isExchange: false, isSmartWallet: false });
    }
  });

  test("does not leak a warning when nothing matched", () => {
    const result = checkKnownAddress("not-an-address", "ethereum");
    expect(result.isExchange).toBe(false);
    expect(result.warningMessage).toBeUndefined();
    expect(result.exchangeName).toBeUndefined();
  });

  test("handles empty input without throwing", () => {
    expect(() => checkKnownAddress("", "ethereum")).not.toThrow();
    expect(checkKnownAddress("", "ethereum").isExchange).toBe(false);
  });

  test("never reports smart-wallet status from the address list alone", () => {
    for (const network of NETWORKS) {
      const [address] = Object.entries(KNOWN_EXCHANGE_ADDRESSES[network])[0];
      expect(checkKnownAddress(address, network).isSmartWallet).toBe(false);
    }
  });
});

describe("getWalletRecommendation", () => {
  test("returns non-empty advice for every network", () => {
    for (const network of NETWORKS) {
      expect(getWalletRecommendation(network).trim().length).toBeGreaterThan(0);
    }
  });

  test("recommends chain-appropriate wallets", () => {
    expect(getWalletRecommendation("solana")).toContain("Phantom");
    expect(getWalletRecommendation("base")).toContain("Coinbase Wallet");
    expect(getWalletRecommendation("ethereum")).toContain("MetaMask");
  });

  test("never recommends a Solana wallet on an EVM chain", () => {
    for (const network of EVM_NETWORKS) {
      expect(getWalletRecommendation(network)).not.toContain("Phantom");
    }
  });
});

describe("getNonEOAWarning", () => {
  test("names the exchange and appends the recommendation", () => {
    const warning = getNonEOAWarning("ethereum", false, { name: "Coinbase" });
    expect(warning).toContain("Coinbase");
    expect(warning).toContain(getWalletRecommendation("ethereum"));
  });

  test("exchange information outranks the contract branch", () => {
    const warning = getNonEOAWarning("ethereum", true, { name: "Kraken" });
    expect(warning).toContain("Kraken");
    expect(warning).not.toContain("smart contract address");
  });

  test("warns about a contract when no exchange is known", () => {
    const warning = getNonEOAWarning("base", true);
    expect(warning).toContain("smart contract");
    expect(warning).toContain(getWalletRecommendation("base"));
  });

  test("says nothing for a plain EOA", () => {
    expect(getNonEOAWarning("ethereum", false)).toBe("");
    expect(getNonEOAWarning("solana", false)).toBe("");
  });
});

describe("VESTING_CONFIG", () => {
  test("hold periods increase with counterparty risk", () => {
    expect(VESTING_CONFIG.MIN_HOLD_PERIOD_MS).toBeLessThan(
      VESTING_CONFIG.APP_EARNINGS_HOLD_PERIOD_MS,
    );
    expect(VESTING_CONFIG.APP_EARNINGS_HOLD_PERIOD_MS).toBeLessThan(
      VESTING_CONFIG.REFERRAL_HOLD_PERIOD_MS,
    );
  });

  test("every hold period is a positive whole number of milliseconds", () => {
    for (const key of [
      "MIN_HOLD_PERIOD_MS",
      "APP_EARNINGS_HOLD_PERIOD_MS",
      "REFERRAL_HOLD_PERIOD_MS",
    ] as const) {
      expect(Number.isInteger(VESTING_CONFIG[key])).toBe(true);
      expect(VESTING_CONFIG[key]).toBeGreaterThan(0);
    }
  });

  test("the daily release hour is a valid UTC hour", () => {
    expect(Number.isInteger(VESTING_CONFIG.DAILY_RELEASE_HOUR_UTC)).toBe(true);
    expect(VESTING_CONFIG.DAILY_RELEASE_HOUR_UTC).toBeGreaterThanOrEqual(0);
    expect(VESTING_CONFIG.DAILY_RELEASE_HOUR_UTC).toBeLessThanOrEqual(23);
  });

  test("the daily redemption cap is a fraction that actually caps", () => {
    expect(VESTING_CONFIG.MAX_DAILY_REDEMPTION_PERCENT).toBeGreaterThan(0);
    expect(VESTING_CONFIG.MAX_DAILY_REDEMPTION_PERCENT).toBeLessThanOrEqual(1);
  });
});

describe("POINT_SOURCE_VESTING", () => {
  test("every source maps to a non-negative period", () => {
    const entries = Object.entries(POINT_SOURCE_VESTING);
    expect(entries.length).toBeGreaterThan(0);
    for (const [, ms] of entries) {
      expect(Number.isInteger(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
  });

  test("every non-zero period is one of the declared hold periods", () => {
    const declared = new Set([
      VESTING_CONFIG.MIN_HOLD_PERIOD_MS,
      VESTING_CONFIG.APP_EARNINGS_HOLD_PERIOD_MS,
      VESTING_CONFIG.REFERRAL_HOLD_PERIOD_MS,
    ]);
    for (const [, ms] of Object.entries(POINT_SOURCE_VESTING)) {
      if (ms === 0) continue;
      expect(declared.has(ms)).toBe(true);
    }
  });

  test("every referral source vests at the longest period", () => {
    for (const [source, ms] of Object.entries(POINT_SOURCE_VESTING)) {
      if (!source.startsWith("referral_")) continue;
      expect(ms).toBe(VESTING_CONFIG.REFERRAL_HOLD_PERIOD_MS);
    }
  });

  test("only a direct purchase skips vesting entirely", () => {
    const unvested = Object.entries(POINT_SOURCE_VESTING)
      .filter(([, ms]) => ms === 0)
      .map(([source]) => source);
    expect(unvested).toEqual(["direct_purchase"]);
  });
});

describe("FRAUD_THRESHOLDS", () => {
  test("ratio thresholds are fractions, not percentages", () => {
    for (const key of ["HIGH_REDEMPTION_RATIO", "PRICE_DROP_THRESHOLD"] as const) {
      expect(FRAUD_THRESHOLDS[key]).toBeGreaterThan(0);
      expect(FRAUD_THRESHOLDS[key]).toBeLessThanOrEqual(1);
    }
  });

  test("count and window thresholds are positive whole numbers", () => {
    for (const key of [
      "FAST_REDEEM_HOURS",
      "SHARED_ADDRESS_MAX_USERS",
      "FAILED_REDEMPTION_FLAG",
      "PRICE_DROP_WINDOW_MINUTES",
    ] as const) {
      expect(Number.isInteger(FRAUD_THRESHOLDS[key])).toBe(true);
      expect(FRAUD_THRESHOLDS[key]).toBeGreaterThan(0);
    }
  });

  test("the fast-redeem window sits inside the shortest vesting period", () => {
    expect(FRAUD_THRESHOLDS.FAST_REDEEM_HOURS * 60 * 60 * 1000).toBeLessThanOrEqual(
      VESTING_CONFIG.MIN_HOLD_PERIOD_MS,
    );
  });
});

describe("SMART_WALLET_PATTERNS", () => {
  test("every pattern is a non-empty lowercase hex prefix", () => {
    const entries = Object.entries(SMART_WALLET_PATTERNS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [, pattern] of entries) {
      expect(pattern).toMatch(/^0x[0-9a-f]+$/);
    }
  });

  test("patterns are distinct", () => {
    const values = Object.values(SMART_WALLET_PATTERNS);
    expect(new Set(values).size).toBe(values.length);
  });
});
