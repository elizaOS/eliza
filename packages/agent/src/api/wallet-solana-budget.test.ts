/**
 * Production-boundary coverage for Solana secret decoding limits.
 */

import { afterEach, describe, expect, it } from "vitest";
import { validateSolanaPrivateKey } from "./wallet.ts";
import { syncSolanaPublicKeyEnv } from "./wallet-env-sync.ts";

const originalPublicKey = process.env.SOLANA_PUBLIC_KEY;
const originalWalletPublicKey = process.env.WALLET_PUBLIC_KEY;

afterEach(() => {
  if (originalPublicKey === undefined) delete process.env.SOLANA_PUBLIC_KEY;
  else process.env.SOLANA_PUBLIC_KEY = originalPublicKey;
  if (originalWalletPublicKey === undefined)
    delete process.env.WALLET_PUBLIC_KEY;
  else process.env.WALLET_PUBLIC_KEY = originalWalletPublicKey;
});

describe("Solana secret budgets", () => {
  it("rejects oversized base58 through the public validation result", () => {
    const result = validateSolanaPrivateKey("2".repeat(160_000));
    expect(result.valid).toBe(false);
    expect(result.error).toContain("exceeds 512 characters");
  });

  it("fails closed before env mutation in the startup sync path", () => {
    process.env.SOLANA_PUBLIC_KEY = "existing-solana";
    process.env.WALLET_PUBLIC_KEY = "existing-wallet";
    expect(syncSolanaPublicKeyEnv("2".repeat(160_000))).toBeNull();
    expect(process.env.SOLANA_PUBLIC_KEY).toBe("existing-solana");
    expect(process.env.WALLET_PUBLIC_KEY).toBe("existing-wallet");
  });
});
