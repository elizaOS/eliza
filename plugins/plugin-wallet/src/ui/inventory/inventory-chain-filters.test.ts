/**
 * Covers the inventory chain-filter helpers against the real module and the
 * real chain registry: normalization of missing/partial filter state onto the
 * all-enabled defaults, alias-aware chain matching restricted to the primary
 * chains, single-chain focus detection, and toggle semantics on normalized
 * copies. No module under test is mocked.
 */
import { describe, expect, it } from "vitest";
import {
  computeSingleChainFocus,
  DEFAULT_INVENTORY_CHAIN_FILTERS,
  matchesInventoryChainFilter,
  normalizeInventoryChainFilters,
  toggleInventoryChainFilter,
} from "./inventory-chain-filters.ts";

describe("normalizeInventoryChainFilters", () => {
  it("treats null and undefined as every primary chain enabled", () => {
    expect(normalizeInventoryChainFilters(null)).toEqual(
      DEFAULT_INVENTORY_CHAIN_FILTERS,
    );
    expect(normalizeInventoryChainFilters(undefined)).toEqual(
      DEFAULT_INVENTORY_CHAIN_FILTERS,
    );
    expect(normalizeInventoryChainFilters({})).toEqual(
      DEFAULT_INVENTORY_CHAIN_FILTERS,
    );
  });

  it("fills only the missing keys of a partial filter object", () => {
    expect(normalizeInventoryChainFilters({ ethereum: false })).toEqual({
      ethereum: false,
      base: true,
      bsc: true,
      avax: true,
      solana: true,
    });
  });

  it("returns a new object and never mutates its input", () => {
    const partial = { bsc: false };
    const normalized = normalizeInventoryChainFilters(partial);
    expect(partial).toEqual({ bsc: false });
    expect(normalized).not.toBe(partial);
    expect(normalized.bsc).toBe(false);
  });
});

describe("matchesInventoryChainFilter", () => {
  it("resolves case-insensitive aliases onto primary chains", () => {
    expect(matchesInventoryChainFilter("ETH", null)).toBe(true);
    expect(matchesInventoryChainFilter("  mainnet ", null)).toBe(true);
    expect(matchesInventoryChainFilter("SOL", undefined)).toBe(true);
    expect(matchesInventoryChainFilter("BNB SMART CHAIN", {})).toBe(true);
    expect(matchesInventoryChainFilter("avalanche c-chain", null)).toBe(true);
  });

  it("rejects resolvable non-primary chains even with all filters enabled", () => {
    expect(matchesInventoryChainFilter("arbitrum", null)).toBe(false);
    expect(matchesInventoryChainFilter("optimism", null)).toBe(false);
    expect(matchesInventoryChainFilter("polygon", null)).toBe(false);
  });

  it("rejects unknown chains instead of defaulting to a primary key", () => {
    expect(matchesInventoryChainFilter("sui", null)).toBe(false);
    expect(matchesInventoryChainFilter("", null)).toBe(false);
  });

  it("honours an explicit false on the resolved primary chain only", () => {
    expect(matchesInventoryChainFilter("eth", { ethereum: false })).toBe(false);
    expect(matchesInventoryChainFilter("eth", { base: false })).toBe(true);
    expect(
      matchesInventoryChainFilter("sol", { solana: false, base: true }),
    ).toBe(false);
  });
});

describe("computeSingleChainFocus", () => {
  it("returns null when nothing or everything is enabled after normalization", () => {
    expect(computeSingleChainFocus(null)).toBeNull();
    expect(computeSingleChainFocus(undefined)).toBeNull();
    expect(computeSingleChainFocus(DEFAULT_INVENTORY_CHAIN_FILTERS)).toBeNull();
  });

  it("a partial object normalizes to all-enabled and therefore has no focus", () => {
    expect(computeSingleChainFocus({})).toBeNull();
    expect(computeSingleChainFocus({ solana: true })).toBeNull();
  });

  it("returns the only enabled primary chain", () => {
    expect(
      computeSingleChainFocus({
        ethereum: false,
        base: false,
        bsc: false,
        avax: false,
        solana: true,
      }),
    ).toBe("solana");
  });

  it("returns null when two or more chains stay enabled", () => {
    expect(
      computeSingleChainFocus({
        ethereum: false,
        base: true,
        bsc: true,
        avax: false,
        solana: false,
      }),
    ).toBeNull();
  });
});

describe("toggleInventoryChainFilter", () => {
  it("flips one key off an all-enabled baseline without mutating the input", () => {
    const input = DEFAULT_INVENTORY_CHAIN_FILTERS;
    const toggled = toggleInventoryChainFilter(input, "solana");
    expect(toggled.solana).toBe(false);
    expect(toggled.ethereum).toBe(true);
    expect(toggled).not.toBe(input);
    expect(input.solana).toBe(true);
  });

  it("round-trips back to the original posture when toggled twice", () => {
    const once = toggleInventoryChainFilter(null, "bsc");
    const twice = toggleInventoryChainFilter(once, "bsc");
    expect(twice).toEqual(DEFAULT_INVENTORY_CHAIN_FILTERS);
  });

  it("normalizes first, preserving explicit partial values while flipping the target", () => {
    const toggled = toggleInventoryChainFilter({ bsc: false }, "avax");
    expect(toggled).toEqual({
      ethereum: true,
      base: true,
      bsc: false,
      avax: false,
      solana: true,
    });
  });
});
