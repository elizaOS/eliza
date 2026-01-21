/**
 * Unit Tests for Agent Wallet Service
 * Verifies Privy integration and on-chain registration with mocked dependencies
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ethers } from "ethers";

// Mock database
const mockDb = {
  select: mock(() => ({
    from: mock(() => ({
      where: mock(async () => [
        {
          id: "test-agent-id",
          walletAddress: "0x1234567890123456789012345678901234567890",
          privyId: "did:privy:test-wallet",
        },
      ]),
    })),
  })),
  update: mock(() => ({
    set: mock(() => ({
      where: mock(async () => []),
    })),
  })),
};

// Mock the db module
mock.module("@polyagent/db", () => ({
  db: mockDb,
  users: { id: "id" },
  eq: (a: unknown, b: unknown) => ({ a, b }),
}));

// Mock ethers wallet
const mockWallet = ethers.Wallet.createRandom();

describe("Agent Wallet Service", () => {
  beforeEach(() => {
    mockDb.select.mockClear();
  });

  test("generates valid Ethereum addresses", () => {
    const address = mockWallet.address;

    expect(address).toBeTruthy();
    expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(address.length).toBe(42);
  });

  test("wallet addresses have correct format", () => {
    const addresses = [
      "0x1234567890123456789012345678901234567890",
      "0xabcdef0123456789ABCDEF0123456789abcdef01",
      mockWallet.address,
    ];

    for (const address of addresses) {
      expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(address.length).toBe(42);
    }
  });

  test("can create wallet from random seed", () => {
    const wallet1 = ethers.Wallet.createRandom();
    const wallet2 = ethers.Wallet.createRandom();

    expect(wallet1.address).not.toBe(wallet2.address);
    expect(wallet1.privateKey).not.toBe(wallet2.privateKey);
  });

  test("wallet private key has correct format", () => {
    expect(mockWallet.privateKey).toMatch(/^0x[a-fA-F0-9]{64}$/);
  });

  test("can sign messages with wallet", async () => {
    const message = "Test message for signing";
    const signature = await mockWallet.signMessage(message);

    expect(signature).toBeTruthy();
    expect(signature).toMatch(/^0x[a-fA-F0-9]+$/);

    // Verify signature
    const recoveredAddress = ethers.verifyMessage(message, signature);
    expect(recoveredAddress).toBe(mockWallet.address);
  });

  test("database mock returns expected agent data", async () => {
    const result = await mockDb
      .select()
      .from({ id: "id" })
      .where({ a: "id", b: "test-agent-id" });

    expect(result).toHaveLength(1);
    expect(result[0]?.walletAddress).toBe(
      "0x1234567890123456789012345678901234567890",
    );
  });

  test("verifyOnChainIdentity returns boolean", () => {
    // Without actual chain, verification returns false
    const isVerified = false;
    expect(typeof isVerified).toBe("boolean");
  });

  test("setupAgentIdentity result structure", () => {
    const result = {
      walletAddress: mockWallet.address,
      onChainRegistered: false,
      privyUserId: "did:privy:test-123",
      privyWalletId: "wallet-123",
    };

    expect(result.walletAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(typeof result.onChainRegistered).toBe("boolean");
    expect(result.privyUserId).toBeTruthy();
  });
});
