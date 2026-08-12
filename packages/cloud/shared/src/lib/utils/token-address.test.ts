/**
 * Deterministic unit coverage for `normalizeTokenAddress`. The function is pure,
 * so every case is an exact input/output assertion.
 *
 * The behaviours worth pinning are the ones a refactor can invert without any
 * other test noticing: an explicit EVM chain lowercases regardless of what the
 * address looks like, an unknown or absent chain falls back to a strict
 * 0x + 40-hex shape check, and everything else is returned byte-for-byte so a
 * case-sensitive base58 or bech32 address is never corrupted.
 */

import { describe, expect, it } from "vitest";
import { normalizeTokenAddress } from "./token-address";

const MIXED_EVM = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";
const LOWER_EVM = MIXED_EVM.toLowerCase();
/** Real-shaped Solana mint: base58, case-sensitive, cannot begin with "0". */
const SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** Cosmos bech32: lowercase payload but a case-sensitive encoding overall. */
const BECH32 = "cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu";

describe("normalizeTokenAddress", () => {
  describe("known EVM chain", () => {
    it.each([
      "ethereum",
      "base",
      "arbitrum",
      "optimism",
      "polygon",
      "avalanche",
      "bsc",
      "binance",
      "zksync",
      "zora",
    ])("lowercases on %s", (chain) => {
      expect(normalizeTokenAddress(MIXED_EVM, chain)).toBe(LOWER_EVM);
    });

    it("matches the chain name case-insensitively", () => {
      expect(normalizeTokenAddress(MIXED_EVM, "Ethereum")).toBe(LOWER_EVM);
      expect(normalizeTokenAddress(MIXED_EVM, "BASE")).toBe(LOWER_EVM);
      // Asserted on a NON-EVM-shaped address on purpose: with an 0x address the
      // shape fallback lowercases it anyway, so a broken chain fold would still
      // look correct. Here the chain lookup is the only path that can lowercase.
      expect(normalizeTokenAddress(SOLANA, "Ethereum")).toBe(SOLANA.toLowerCase());
      expect(normalizeTokenAddress(SOLANA, "BASE")).toBe(SOLANA.toLowerCase());
    });

    it("trusts the chain label over the address shape", () => {
      // Documented consequence of the decision tree: an explicit EVM chain
      // lowercases whatever it is given. A caller that mislabels a base58
      // address as EVM gets a destructively lowercased value back, so the
      // chain argument must come from the same source as the address.
      expect(normalizeTokenAddress(SOLANA, "ethereum")).toBe(SOLANA.toLowerCase());
    });
  });

  describe("unknown or absent chain", () => {
    it.each([undefined, null, "", "solana", "sui", "tron", "1", "eth-mainnet"])(
      "falls back to the address shape for chain %p",
      (chain) => {
        expect(normalizeTokenAddress(MIXED_EVM, chain)).toBe(LOWER_EVM);
      },
    );

    it("leaves case-sensitive non-EVM addresses untouched", () => {
      expect(normalizeTokenAddress(SOLANA)).toBe(SOLANA);
      expect(normalizeTokenAddress(SOLANA, "solana")).toBe(SOLANA);
      expect(normalizeTokenAddress(BECH32, "cosmos")).toBe(BECH32);
    });
  });

  describe("shape heuristic is strict", () => {
    it.each([
      ["too short", "0xAbCdEf"],
      ["39 hex digits", `0x${"A".repeat(39)}`],
      ["41 hex digits", `0x${"A".repeat(41)}`],
      ["non-hex digit", `0x${"A".repeat(39)}Z`],
      ["missing 0x prefix", "AbCdEf0123456789AbCdEf0123456789AbCdEf01"],
      ["uppercase 0X prefix", MIXED_EVM.replace("0x", "0X")],
      ["leading whitespace", ` ${MIXED_EVM}`],
      ["trailing whitespace", `${MIXED_EVM} `],
    ])("preserves casing for a %s value", (_label, address) => {
      expect(normalizeTokenAddress(address)).toBe(address);
    });
  });

  describe("invariants", () => {
    it("is idempotent", () => {
      for (const [address, chain] of [
        [MIXED_EVM, "ethereum"],
        [MIXED_EVM, undefined],
        [SOLANA, "solana"],
        [BECH32, undefined],
      ] as Array<[string, string | undefined]>) {
        const once = normalizeTokenAddress(address, chain);
        expect(normalizeTokenAddress(once, chain)).toBe(once);
      }
    });

    it("never changes the length or the character set beyond case", () => {
      for (const address of [MIXED_EVM, SOLANA, BECH32]) {
        const out = normalizeTokenAddress(address, "ethereum");
        expect(out).toHaveLength(address.length);
        expect(out).toBe(address.toLowerCase());
      }
    });

    it("returns the empty string unchanged", () => {
      expect(normalizeTokenAddress("")).toBe("");
      expect(normalizeTokenAddress("", "ethereum")).toBe("");
    });
  });
});
