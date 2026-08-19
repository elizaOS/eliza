/**
 * Character budget for Solana secret and address base58. `base58Decode` in
 * `wallet.ts` / `wallet-env-sync.ts` does one BigInt multiply per input
 * character; an 88-character 64-byte secret is honest, but a megabyte of
 * alphabet text is quadratic and hangs first-time setup / import /
 * `validatePrivateKey` on the request thread.
 */

/** Ceiling for one Solana secret or address string (base58 or JSON byte array). */
export const MAX_SOLANA_SECRET_CHARS = 512;

export const SOLANA_SECRET_TOO_LONG = `Solana secret exceeds ${MAX_SOLANA_SECRET_CHARS} characters`;

/** Throw before BigInt-per-character decode when `value` cannot be an honest key. */
export function assertSolanaSecretCharBudget(value: string): void {
  if (value.length > MAX_SOLANA_SECRET_CHARS) {
    throw new Error(SOLANA_SECRET_TOO_LONG);
  }
}
