import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  ElizaError: class ElizaError extends Error {
    constructor(message: string, opts: unknown) {
      super(message);
      (this as never as Record<string, unknown>).code = (
        opts as { code?: string }
      )?.code;
    }
  },
}));

import {
  assertSolanaBase58CharBudget,
  assertSolanaSecretCharBudget,
  MAX_SOLANA_BASE58_CHARS,
  MAX_SOLANA_SECRET_CHARS,
} from "./solana-secret-budget.ts";

describe("assertSolanaSecretCharBudget", () => {
  it("accepts honest-length secrets", () => {
    expect(() => assertSolanaSecretCharBudget("a".repeat(88))).not.toThrow();
    expect(() =>
      assertSolanaSecretCharBudget("a".repeat(MAX_SOLANA_SECRET_CHARS)),
    ).not.toThrow();
  });

  it("throws on oversized input", () => {
    expect(() =>
      assertSolanaSecretCharBudget("a".repeat(MAX_SOLANA_SECRET_CHARS + 1)),
    ).toThrow("exceeds");
  });
});

describe("assertSolanaBase58CharBudget", () => {
  it("accepts 64-byte base58 lengths", () => {
    expect(() =>
      assertSolanaBase58CharBudget("a".repeat(MAX_SOLANA_BASE58_CHARS)),
    ).not.toThrow();
  });

  it("throws on oversized base58", () => {
    expect(() =>
      assertSolanaBase58CharBudget("a".repeat(MAX_SOLANA_BASE58_CHARS + 1)),
    ).toThrow("exceeds");
  });
});
