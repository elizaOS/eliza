/**
 * Wallet RPC provider selection. Normalization resolves legacy aliases
 * (elizacloud → eliza-cloud, helius → helius-birdeye), is case/space-insensitive,
 * and is per-chain: a provider valid on one chain (e.g. alchemy on EVM) must be
 * rejected on a chain that doesn't offer it (solana). Unknown/blank values fall
 * back to the safe Eliza Cloud default rather than a broken provider id.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WALLET_RPC_SELECTIONS,
  normalizeWalletRpcProviderId,
  normalizeWalletRpcSelections,
} from "./wallet.ts";

describe("normalizeWalletRpcProviderId", () => {
  it("accepts valid ids case/space-insensitively", () => {
    expect(normalizeWalletRpcProviderId("evm", "  Alchemy ")).toBe("alchemy");
    expect(normalizeWalletRpcProviderId("solana", "helius-birdeye")).toBe(
      "helius-birdeye",
    );
  });

  it("resolves legacy aliases", () => {
    expect(normalizeWalletRpcProviderId("evm", "elizacloud")).toBe(
      "eliza-cloud",
    );
    expect(normalizeWalletRpcProviderId("solana", "helius")).toBe(
      "helius-birdeye",
    );
  });

  it("rejects providers not offered on the given chain", () => {
    expect(normalizeWalletRpcProviderId("solana", "alchemy")).toBeNull();
    expect(normalizeWalletRpcProviderId("evm", "nodereal")).toBeNull(); // bsc-only
    expect(normalizeWalletRpcProviderId("evm", "")).toBeNull();
    expect(normalizeWalletRpcProviderId("evm", null)).toBeNull();
  });
});

describe("normalizeWalletRpcSelections", () => {
  it("fills each chain, falling back to the Eliza Cloud default", () => {
    expect(normalizeWalletRpcSelections(null)).toEqual(
      DEFAULT_WALLET_RPC_SELECTIONS,
    );
    expect(
      normalizeWalletRpcSelections({ evm: "ankr", solana: "bogus" }),
    ).toEqual({
      evm: "ankr",
      bsc: "eliza-cloud",
      solana: "eliza-cloud",
    });
  });
});
