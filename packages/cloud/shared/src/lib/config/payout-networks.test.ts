// Exercises payout networks behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import {
  assertValidNetwork,
  getMainnetEquivalent,
  getTestnetEquivalent,
  isValidNetwork,
} from "./payout-networks";

/**
 * Payout network identifiers route real money to the right chain. The
 * mainnet↔testnet mapping must round-trip exactly (a mismatch would send funds
 * on the wrong chain), and validation must reject any unknown network string
 * before it reaches a payout call.
 */

const MAINNETS = ["ethereum", "base", "bnb", "solana"] as const;

describe("mainnet ↔ testnet mapping", () => {
  test("every mainnet round-trips through its testnet equivalent", () => {
    for (const net of MAINNETS) {
      const testnet = getTestnetEquivalent(net);
      expect(testnet).not.toBe(net);
      expect(getMainnetEquivalent(testnet)).toBe(net);
    }
  });

  test("known testnet labels map to the expected mainnet", () => {
    expect(getMainnetEquivalent("ethereum-sepolia")).toBe("ethereum");
    expect(getMainnetEquivalent("solana-devnet")).toBe("solana");
  });
});

describe("isValidNetwork / assertValidNetwork", () => {
  test("accepts configured networks, rejects unknown strings", () => {
    expect(isValidNetwork("ethereum")).toBe(true);
    expect(isValidNetwork("base-sepolia")).toBe(true);
    expect(isValidNetwork("dogecoin")).toBe(false);
    expect(isValidNetwork("")).toBe(false);
  });

  test("assertValidNetwork throws on an unknown network", () => {
    expect(() => assertValidNetwork("ethereum")).not.toThrow();
    expect(() => assertValidNetwork("dogecoin")).toThrow(/Invalid network/);
  });
});
