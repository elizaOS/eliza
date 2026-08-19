/**
 * Isolated overflow tests for the Solana secret character budget.
 * Deterministic — no wallet import, Noble curves, env, or network.
 */
import { describe, expect, it } from "vitest";
import {
  assertSolanaSecretCharBudget,
  MAX_SOLANA_SECRET_CHARS,
  SOLANA_SECRET_TOO_LONG,
} from "./solana-secret-budget.ts";

describe("assertSolanaSecretCharBudget", () => {
  it("accepts an honest 64-byte base58 length", () => {
    expect(() => assertSolanaSecretCharBudget("2".repeat(88))).not.toThrow();
    expect(() =>
      assertSolanaSecretCharBudget("2".repeat(MAX_SOLANA_SECRET_CHARS)),
    ).not.toThrow();
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
});
