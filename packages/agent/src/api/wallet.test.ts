import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deriveEvmAddress,
  deriveSolanaAddress,
  getWalletAddresses,
} from "./wallet.js";

describe("getWalletAddresses", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WALLET_SOURCE_EVM;
    delete process.env.WALLET_SOURCE_SOLANA;
    delete process.env.MILADY_CLOUD_EVM_ADDRESS;
    delete process.env.MILADY_CLOUD_SOLANA_ADDRESS;
    delete process.env.EVM_PRIVATE_KEY;
    delete process.env.SOLANA_PRIVATE_KEY;
    delete process.env.STEWARD_EVM_ADDRESS;
    delete process.env.STEWARD_SOLANA_ADDRESS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("prefers the configured cloud wallet addresses over steward/local fallbacks", () => {
    process.env.WALLET_SOURCE_EVM = "cloud";
    process.env.WALLET_SOURCE_SOLANA = "cloud";
    process.env.MILADY_CLOUD_EVM_ADDRESS =
      "0x1234567890abcdef1234567890abcdef12345678";
    process.env.MILADY_CLOUD_SOLANA_ADDRESS =
      "8RsmpM7Ztk5H2nesQSjk8okmFTiZFk4kBUcyaygPrVxa";
    process.env.STEWARD_EVM_ADDRESS =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    process.env.STEWARD_SOLANA_ADDRESS =
      "So11111111111111111111111111111111111111112";

    expect(getWalletAddresses()).toEqual({
      evmAddress: "0x1234567890abcdef1234567890abcdef12345678",
      solanaAddress: "8RsmpM7Ztk5H2nesQSjk8okmFTiZFk4kBUcyaygPrVxa",
    });
  });

  it("does not silently fall back to steward when local source is selected", () => {
    process.env.WALLET_SOURCE_EVM = "local";
    process.env.WALLET_SOURCE_SOLANA = "local";
    process.env.STEWARD_EVM_ADDRESS =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    process.env.STEWARD_SOLANA_ADDRESS =
      "8RsmpM7Ztk5H2nesQSjk8okmFTiZFk4kBUcyaygPrVxa";

    expect(getWalletAddresses()).toEqual({
      evmAddress: null,
      solanaAddress: null,
    });
  });

  it("derives local addresses when local source is configured", () => {
    process.env.WALLET_SOURCE_EVM = "local";
    process.env.WALLET_SOURCE_SOLANA = "local";
    process.env.EVM_PRIVATE_KEY = `0x${"11".repeat(32)}`;
    process.env.SOLANA_PRIVATE_KEY =
      "4vJ9JU1bJJhzV4vWJjY8VdCU7hQz7xY8DbDeihdj5Z8rLz6iWvVx2oyWZMh1CT3VkHxVkkpFmS6rWCYpgGN7DDDe";

    expect(getWalletAddresses()).toEqual({
      evmAddress: deriveEvmAddress(process.env.EVM_PRIVATE_KEY),
      solanaAddress: deriveSolanaAddress(process.env.SOLANA_PRIVATE_KEY),
    });
  });
});
