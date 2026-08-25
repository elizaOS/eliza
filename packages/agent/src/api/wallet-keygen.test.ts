/**
 * Coverage for local wallet key generation in `wallet-keygen.ts`.
 *
 * `generateWalletKeys` must emit a secp256k1 EVM secret with a matching EIP-55
 * address and an ed25519 Solana secret whose public half round-trips through
 * `setSolanaWalletEnv`. `deriveEvmAddress` is the 0x-prefix / no-prefix recovery
 * path. No network, filesystem, or mocked crypto — the real generators run.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  deriveEvmAddress,
  generateWalletKeys,
  setSolanaWalletEnv,
} from "./wallet-keygen.ts";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Hardhat/Anvil account #0 — known EIP-55 checksum. */
const ANVIL_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/** secp256k1 generator point (private key 1) — mixed-case EIP-55. */
const PK1 = `0x${"00".repeat(31)}01`;
const PK1_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

const originalSolanaPrivateKey = process.env.SOLANA_PRIVATE_KEY;
const originalSolanaPublicKey = process.env.SOLANA_PUBLIC_KEY;
const originalWalletPublicKey = process.env.WALLET_PUBLIC_KEY;

afterEach(() => {
  if (originalSolanaPrivateKey === undefined) {
    delete process.env.SOLANA_PRIVATE_KEY;
  } else {
    process.env.SOLANA_PRIVATE_KEY = originalSolanaPrivateKey;
  }
  if (originalSolanaPublicKey === undefined) {
    delete process.env.SOLANA_PUBLIC_KEY;
  } else {
    process.env.SOLANA_PUBLIC_KEY = originalSolanaPublicKey;
  }
  if (originalWalletPublicKey === undefined) {
    delete process.env.WALLET_PUBLIC_KEY;
  } else {
    process.env.WALLET_PUBLIC_KEY = originalWalletPublicKey;
  }
});

function expectBase58(value: string): void {
  expect(value.length).toBeGreaterThan(0);
  for (const char of value) {
    expect(B58.includes(char)).toBe(true);
  }
}

describe("deriveEvmAddress", () => {
  it("recovers the Anvil #0 address with a 0x prefix", () => {
    expect(deriveEvmAddress(ANVIL_PRIVATE_KEY)).toBe(ANVIL_ADDRESS);
  });

  it("recovers the same address without a 0x prefix", () => {
    expect(deriveEvmAddress(ANVIL_PRIVATE_KEY.slice(2))).toBe(ANVIL_ADDRESS);
  });

  it("accepts uppercase hex in the secret", () => {
    expect(
      deriveEvmAddress(`0x${ANVIL_PRIVATE_KEY.slice(2).toUpperCase()}`),
    ).toBe(ANVIL_ADDRESS);
  });

  it("checksums the secp256k1 generator-point address (private key 1)", () => {
    expect(deriveEvmAddress(PK1)).toBe(PK1_ADDRESS);
    expect(PK1_ADDRESS).not.toBe(PK1_ADDRESS.toLowerCase());
    expect(PK1_ADDRESS).not.toBe(PK1_ADDRESS.toUpperCase());
  });

  it("is deterministic for the same secret", () => {
    expect(deriveEvmAddress(ANVIL_PRIVATE_KEY)).toBe(
      deriveEvmAddress(ANVIL_PRIVATE_KEY),
    );
  });

  it("rejects the all-zero private key", () => {
    expect(() => deriveEvmAddress(`0x${"00".repeat(32)}`)).toThrow();
  });

  it("rejects an empty secret and a bare 0x prefix", () => {
    expect(() => deriveEvmAddress("")).toThrow();
    expect(() => deriveEvmAddress("0x")).toThrow();
  });
});

describe("generateWalletKeys", () => {
  it("returns four populated fields with the expected encodings", () => {
    const keys = generateWalletKeys();
    expect(keys.evmPrivateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(keys.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expectBase58(keys.solanaPrivateKey);
    expectBase58(keys.solanaAddress);
    expect(keys.solanaPrivateKey.length).toBeGreaterThan(
      keys.solanaAddress.length,
    );
  });

  it("derives the EVM address from the generated secret", () => {
    const keys = generateWalletKeys();
    expect(deriveEvmAddress(keys.evmPrivateKey)).toBe(keys.evmAddress);
    expect(deriveEvmAddress(keys.evmPrivateKey.slice(2))).toBe(keys.evmAddress);
  });

  it("produces distinct wallets across calls", () => {
    const a = generateWalletKeys();
    const b = generateWalletKeys();
    expect(a.evmPrivateKey).not.toBe(b.evmPrivateKey);
    expect(a.evmAddress).not.toBe(b.evmAddress);
    expect(a.solanaPrivateKey).not.toBe(b.solanaPrivateKey);
    expect(a.solanaAddress).not.toBe(b.solanaAddress);
  });
});

describe("setSolanaWalletEnv", () => {
  it("installs a generated 64-byte secret and re-syncs the public key", () => {
    const keys = generateWalletKeys();
    const synced = setSolanaWalletEnv(keys.solanaPrivateKey);
    expect(synced).toBe(keys.solanaAddress);
    expect(process.env.SOLANA_PRIVATE_KEY).toBe(keys.solanaPrivateKey);
    expect(process.env.SOLANA_PUBLIC_KEY).toBe(keys.solanaAddress);
    expect(process.env.WALLET_PUBLIC_KEY).toBe(keys.solanaAddress);
  });

  it("trims surrounding whitespace before writing the env and syncing", () => {
    const keys = generateWalletKeys();
    const synced = setSolanaWalletEnv(` \n\t${keys.solanaPrivateKey}  `);
    expect(synced).toBe(keys.solanaAddress);
    expect(process.env.SOLANA_PRIVATE_KEY).toBe(keys.solanaPrivateKey);
  });

  it("writes an empty secret and returns null without changing public keys", () => {
    process.env.SOLANA_PUBLIC_KEY = "existing-solana";
    process.env.WALLET_PUBLIC_KEY = "existing-wallet";
    expect(setSolanaWalletEnv("   ")).toBeNull();
    expect(process.env.SOLANA_PRIVATE_KEY).toBe("");
    expect(process.env.SOLANA_PUBLIC_KEY).toBe("existing-solana");
    expect(process.env.WALLET_PUBLIC_KEY).toBe("existing-wallet");
  });

  it("writes placeholder sentinels and returns null without deriving a public key", () => {
    process.env.SOLANA_PUBLIC_KEY = "existing-solana";
    expect(setSolanaWalletEnv(" REDACTED ")).toBeNull();
    expect(process.env.SOLANA_PRIVATE_KEY).toBe("REDACTED");
    expect(process.env.SOLANA_PUBLIC_KEY).toBe("existing-solana");
  });

  it("writes an invalid secret and fails closed on public-key sync", () => {
    process.env.SOLANA_PUBLIC_KEY = "existing-solana";
    process.env.WALLET_PUBLIC_KEY = "existing-wallet";
    expect(setSolanaWalletEnv("not-a-valid-base58-key-!!!")).toBeNull();
    expect(process.env.SOLANA_PRIVATE_KEY).toBe("not-a-valid-base58-key-!!!");
    expect(process.env.SOLANA_PUBLIC_KEY).toBe("existing-solana");
    expect(process.env.WALLET_PUBLIC_KEY).toBe("existing-wallet");
  });
});
