/**
 * Character budgets for Solana secrets and addresses. `base58Decode` in
 * `wallet.ts` / `wallet-env-sync.ts` does one BigInt multiply per input
 * character; an 88-character 64-byte secret is honest, but a megabyte of
 * alphabet text is quadratic and hangs first-time setup / import /
 * `validatePrivateKey` on the request thread.
 */

import { ElizaError } from "@elizaos/core";

/** Ceiling for a Solana secret input, including the supported JSON byte-array form. */
export const MAX_SOLANA_SECRET_CHARS = 512;

/** Maximum base58 length of a 64-byte Solana secret; addresses are shorter. */
export const MAX_SOLANA_BASE58_CHARS = 88;

export const SOLANA_SECRET_TOO_LONG = `Solana secret exceeds ${MAX_SOLANA_SECRET_CHARS} characters`;
export const SOLANA_BASE58_TOO_LONG = `Solana base58 value exceeds ${MAX_SOLANA_BASE58_CHARS} characters`;

function throwBudgetError(
  value: string,
  maxChars: number,
  inputKind: "secret" | "base58",
): never {
  throw new ElizaError(
    inputKind === "secret" ? SOLANA_SECRET_TOO_LONG : SOLANA_BASE58_TOO_LONG,
    {
      code: "SOLANA_SECRET_INPUT_TOO_LONG",
      context: { chars: value.length, maxChars, inputKind },
      severity: "fatal",
    },
  );
}

/** Throw before BigInt-per-character decode when `value` cannot be an honest key. */
export function assertSolanaSecretCharBudget(value: string): void {
  if (value.length > MAX_SOLANA_SECRET_CHARS) {
    throwBudgetError(value, MAX_SOLANA_SECRET_CHARS, "secret");
  }
}

/** Throw before base58 decoding when `value` cannot encode a Solana secret. */
export function assertSolanaBase58CharBudget(value: string): void {
  if (value.length > MAX_SOLANA_BASE58_CHARS) {
    throwBudgetError(value, MAX_SOLANA_BASE58_CHARS, "base58");
  }
}
