/**
 * Exercises Solana input budgets through their deterministic wallet and
 * environment-sync entry points without network access.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSolanaBase58CharBudget,
  assertSolanaSecretCharBudget,
  MAX_SOLANA_BASE58_CHARS,
  MAX_SOLANA_SECRET_CHARS,
  SOLANA_BASE58_TOO_LONG,
  SOLANA_SECRET_TOO_LONG,
} from "./solana-secret-budget.ts";
import { importWallet, validateSolanaPrivateKey } from "./wallet.ts";
import { syncSolanaPublicKeyEnv } from "./wallet-env-sync.ts";

const originalSolanaPrivateKey = process.env.SOLANA_PRIVATE_KEY;
const originalSolanaPublicKey = process.env.SOLANA_PUBLIC_KEY;
const originalWalletPublicKey = process.env.WALLET_PUBLIC_KEY;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnv("SOLANA_PRIVATE_KEY", originalSolanaPrivateKey);
  restoreEnv("SOLANA_PUBLIC_KEY", originalSolanaPublicKey);
  restoreEnv("WALLET_PUBLIC_KEY", originalWalletPublicKey);
});

describe("assertSolanaSecretCharBudget", () => {
  it("accepts the supported secret representations", () => {
    expect(() => assertSolanaSecretCharBudget("2".repeat(88))).not.toThrow();
    expect(() =>
      assertSolanaSecretCharBudget("2".repeat(MAX_SOLANA_SECRET_CHARS)),
    ).not.toThrow();
    expect(() =>
      assertSolanaBase58CharBudget("2".repeat(MAX_SOLANA_BASE58_CHARS)),
    ).not.toThrow();

    const jsonSecret = JSON.stringify(Array.from({ length: 64 }, (_, i) => i));
    expect(validateSolanaPrivateKey(jsonSecret)).toMatchObject({
      valid: true,
      chain: "solana",
      error: null,
    });
  });

  it("rejects one character past the budget before any BigInt walk", () => {
    const t0 = performance.now();
    expect(() =>
      assertSolanaSecretCharBudget("2".repeat(MAX_SOLANA_SECRET_CHARS + 1)),
    ).toThrow(SOLANA_SECRET_TOO_LONG);
    expect(performance.now() - t0).toBeLessThan(20);
  });

  it("rejects a 160k hostile payload in well under the origin BigInt hang", () => {
    const t0 = performance.now();
    expect(() => assertSolanaSecretCharBudget("2".repeat(160_000))).toThrow(
      SOLANA_SECRET_TOO_LONG,
    );
    expect(performance.now() - t0).toBeLessThan(20);
  });

  it("rejects impossible base58 lengths at the real validation boundary", () => {
    const result = validateSolanaPrivateKey(
      "2".repeat(MAX_SOLANA_BASE58_CHARS + 1),
    );
    expect(result).toMatchObject({
      valid: false,
      chain: "solana",
      address: null,
    });
    expect(result.error).toContain(SOLANA_BASE58_TOO_LONG);
  });

  it("does not mutate wallet env when import rejects an oversized secret", () => {
    process.env.SOLANA_PRIVATE_KEY = "existing-private";
    process.env.SOLANA_PUBLIC_KEY = "existing-public";
    process.env.WALLET_PUBLIC_KEY = "existing-wallet-public";

    const result = importWallet("solana", "2".repeat(160_000));

    expect(result).toMatchObject({ success: false, chain: "solana" });
    expect(process.env.SOLANA_PRIVATE_KEY).toBe("existing-private");
    expect(process.env.SOLANA_PUBLIC_KEY).toBe("existing-public");
    expect(process.env.WALLET_PUBLIC_KEY).toBe("existing-wallet-public");
  });

  it("does not mutate public-key env when env sync rejects oversized input", () => {
    process.env.SOLANA_PUBLIC_KEY = "existing-public";
    process.env.WALLET_PUBLIC_KEY = "existing-wallet-public";

    expect(syncSolanaPublicKeyEnv("2".repeat(160_000))).toBeNull();
    expect(process.env.SOLANA_PUBLIC_KEY).toBe("existing-public");
    expect(process.env.WALLET_PUBLIC_KEY).toBe("existing-wallet-public");
  });
});
