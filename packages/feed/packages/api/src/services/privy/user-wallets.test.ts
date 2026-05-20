import { describe, expect, it } from "bun:test";
import {
  listEmbeddedEvmWallets,
  listEmbeddedSolanaWallets,
  pickEmbeddedEvmWallet,
  pickEmbeddedSolanaWallet,
} from "./user-wallets";

describe("user-wallets", () => {
  const user = {
    wallet: {
      id: "evm-primary",
      address: "0xAbCDEFabcdefABCDEFabcdefABCDEFabcdefABCD",
      chainType: "ethereum",
      walletClientType: "privy",
      type: "wallet",
    },
    linkedAccounts: [
      {
        id: "solana-embedded",
        address: "6M5J8g5qKJm1W9WTh5tY8WZ7m8vHx9yL8wPwLxS3n3pA",
        chainType: "solana",
        walletClientType: "privy",
        type: "wallet",
      },
      {
        id: "solana-external",
        address: "4f3vKkr8U1c9Yx2J4zQ3o7v9Jv7n3QqB8xS1K8jL5pDe",
        chainType: "solana",
        walletClientType: "phantom",
        type: "wallet",
      },
    ],
  };

  it("keeps EVM embedded wallet selection unchanged", () => {
    expect(listEmbeddedEvmWallets(user)).toEqual([
      {
        walletId: "evm-primary",
        address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      },
    ]);
    expect(pickEmbeddedEvmWallet(user)?.walletId).toBe("evm-primary");
  });

  it("returns only embedded Solana wallets", () => {
    expect(listEmbeddedSolanaWallets(user)).toEqual([
      {
        walletId: "solana-embedded",
        address: "6M5J8g5qKJm1W9WTh5tY8WZ7m8vHx9yL8wPwLxS3n3pA",
      },
    ]);
    expect(pickEmbeddedSolanaWallet(user)?.walletId).toBe("solana-embedded");
  });
});
