import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deriveEvmAddress,
  deriveSolanaAddress,
  fetchSolanaBalances,
  fetchSolanaNativeBalanceViaRpc,
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

describe("fetchSolanaBalances", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails fast when the Solana RPC request fails instead of fabricating a zero balance", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "rpc unavailable",
    } as Response);

    await expect(
      fetchSolanaBalances(
        "8RsmpM7Ztk5H2nesQSjk8okmFTiZFk4kBUcyaygPrVxa",
        "test-key",
      ),
    ).rejects.toThrow("rpc unavailable");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("enriches native SOL and SPL tokens with DexScreener pricing", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            result: { value: 2_500_000_000 },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            result: {
              items: [
                {
                  id: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                  interface: "FungibleToken",
                  content: {
                    metadata: { name: "USD Coin", symbol: "USDC" },
                    links: { image: "https://example.com/usdc.png" },
                  },
                  token_info: {
                    balance: 15_000_000,
                    decimals: 6,
                  },
                },
              ],
            },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            baseToken: {
              address: "So11111111111111111111111111111111111111112",
              symbol: "SOL",
              name: "Wrapped SOL",
            },
            priceUsd: "150",
            liquidity: { usd: 1000000 },
            info: { imageUrl: "https://example.com/sol.png" },
          },
          {
            baseToken: {
              address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              symbol: "USDC",
              name: "USD Coin",
            },
            priceUsd: "1",
            liquidity: { usd: 2000000 },
            info: { imageUrl: "https://example.com/usdc-dex.png" },
          },
        ],
      } as Response);

    await expect(
      fetchSolanaBalances(
        "8RsmpM7Ztk5H2nesQSjk8okmFTiZFk4kBUcyaygPrVxa",
        "test-key",
      ),
    ).resolves.toEqual({
      solBalance: "2.500000000",
      solValueUsd: "375.00",
      tokens: [
        {
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          symbol: "USDC",
          name: "USD Coin",
          balance: "15",
          decimals: 6,
          valueUsd: "15.00",
          logoUrl: "https://example.com/usdc.png",
        },
      ],
    });
  });
});

describe("fetchSolanaNativeBalanceViaRpc", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads SPL token balances and SOL USD value from RPC plus DexScreener", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            result: { value: 1_000_000_000 },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            result: {
              value: [
                {
                  account: {
                    data: {
                      parsed: {
                        info: {
                          mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6k5WqfVnEmC3i7YA",
                          tokenAmount: {
                            amount: "1250000",
                            decimals: 5,
                            uiAmountString: "12.5",
                          },
                        },
                      },
                    },
                  },
                },
              ],
            },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            baseToken: {
              address: "So11111111111111111111111111111111111111112",
              symbol: "SOL",
              name: "Wrapped SOL",
            },
            priceUsd: "140",
            liquidity: { usd: 1000000 },
            info: { imageUrl: "https://example.com/sol.png" },
          },
          {
            baseToken: {
              address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6k5WqfVnEmC3i7YA",
              symbol: "BONK",
              name: "Bonk",
            },
            priceUsd: "0.00002",
            liquidity: { usd: 900000 },
            info: { imageUrl: "https://example.com/bonk.png" },
          },
        ],
      } as Response);

    await expect(
      fetchSolanaNativeBalanceViaRpc(
        "8RsmpM7Ztk5H2nesQSjk8okmFTiZFk4kBUcyaygPrVxa",
        ["https://solana.example/rpc"],
      ),
    ).resolves.toEqual({
      solBalance: "1.000000000",
      solValueUsd: "140.00",
      tokens: [
        {
          mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6k5WqfVnEmC3i7YA",
          symbol: "BONK",
          name: "Bonk",
          balance: "12.5",
          decimals: 5,
          valueUsd: "0.00",
          logoUrl: "https://example.com/bonk.png",
        },
      ],
    });
  });
});
