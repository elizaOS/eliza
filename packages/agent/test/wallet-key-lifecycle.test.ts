/** Exercises real wallet generation, validation, import and environment readback across the configuration-safe leaf and public wallet service; no cryptography or storage is mocked. */
import { afterEach, expect, it, vi } from "vitest";
import {
  generateWalletForChain,
  importWallet,
  validatePrivateKey,
} from "../src/api/wallet.ts";
import {
  deriveEvmAddress,
  deriveSolanaAddress,
  generateWalletKeys,
  syncSolanaPublicKeyEnv,
} from "../src/api/wallet-keygen.ts";

afterEach(() => vi.unstubAllEnvs());

it("round-trips generated keys through import and the shared public-address derivation", () => {
  for (const key of [
    "EVM_PRIVATE_KEY",
    "SOLANA_PRIVATE_KEY",
    "SOLANA_PUBLIC_KEY",
    "WALLET_PUBLIC_KEY",
  ])
    vi.stubEnv(key, undefined);
  const keys = generateWalletKeys();
  expect(deriveEvmAddress(keys.evmPrivateKey)).toBe(keys.evmAddress);
  expect(deriveSolanaAddress(keys.solanaPrivateKey)).toBe(keys.solanaAddress);
  for (const chain of ["evm", "solana"] as const) {
    const generated = generateWalletForChain(chain);
    const validation = validatePrivateKey(generated.privateKey);
    expect(validation.valid).toBe(true);
    expect(validation.address).toBe(generated.address);
    const imported = importWallet(chain, generated.privateKey);
    expect(imported.success).toBe(true);
    expect(imported.address).toBe(generated.address);
    if (chain === "solana") {
      expect(syncSolanaPublicKeyEnv()).toBe(generated.address);
      expect(process.env.SOLANA_PUBLIC_KEY).toBe(generated.address);
      expect(process.env.WALLET_PUBLIC_KEY).toBe(generated.address);
    }
  }
});

it("keeps malformed and oversized secret inputs out of the environment", () => {
  vi.stubEnv("SOLANA_PRIVATE_KEY", "existing-private-key");
  vi.stubEnv("SOLANA_PUBLIC_KEY", "existing-public-key");
  for (const secret of ["[REDACTED]", "invalid!", "1".repeat(10_000)]) {
    expect(importWallet("solana", secret).success).toBe(false);
    expect(syncSolanaPublicKeyEnv(secret)).toBeNull();
    expect(process.env.SOLANA_PRIVATE_KEY).toBe("existing-private-key");
    expect(process.env.SOLANA_PUBLIC_KEY).toBe("existing-public-key");
  }
});
