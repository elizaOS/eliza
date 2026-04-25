import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PUBLIC_SOLANA_RPC_URLS,
  DEFAULT_PUBLIC_SOLANA_TESTNET_RPC_URLS,
  resolveSolanaRpcUrls,
  resolveWalletRpcReadiness,
} from "../wallet-rpc.js";

function normalized(url: string): string {
  return new URL(url).toString();
}

describe("wallet RPC resolution", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SOLANA_RPC_URL;
    delete process.env.SOLANA_TESTNET_RPC_URL;
    delete process.env.HELIUS_API_KEY;
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZAOS_CLOUD_BASE_URL;
    delete process.env.ELIZA_WALLET_NETWORK;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("includes public Solana RPCs without requiring cloud-managed access", () => {
    const urls = resolveSolanaRpcUrls();

    expect(urls).toEqual(
      expect.arrayContaining(DEFAULT_PUBLIC_SOLANA_RPC_URLS.map(normalized)),
    );
  });

  it("uses public Solana testnet RPCs when the wallet network is testnet", () => {
    process.env.ELIZA_WALLET_NETWORK = "testnet";

    const urls = resolveSolanaRpcUrls({ walletNetwork: "testnet" });

    expect(urls).toEqual(
      expect.arrayContaining(
        DEFAULT_PUBLIC_SOLANA_TESTNET_RPC_URLS.map(normalized),
      ),
    );
  });

  it("marks Solana balances ready when public Solana RPCs are available", () => {
    const readiness = resolveWalletRpcReadiness(null);

    expect(readiness.solanaBalanceReady).toBe(true);
    expect(readiness.solanaRpcUrls).toEqual(
      expect.arrayContaining(DEFAULT_PUBLIC_SOLANA_RPC_URLS.map(normalized)),
    );
  });
});
