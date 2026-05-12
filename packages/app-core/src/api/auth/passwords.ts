/**
 * Password hashing + strength gating for the P1 auth path.
 *
 * Backed by `@node-rs/argon2` per plan §11 (Rust prebuilt binaries, no
 * native compile step on Bun/Linux CI). We use argon2id with parameters
 * lifted from current OWASP Password Storage guidance:
 *
 *   memoryCost: 19_456 KiB (≈19 MiB)
 *   timeCost:   2 iterations
 *   parallelism: 1
 *
 * `verifyPassword` delegates to `@node-rs/argon2`'s `verify`, which is
 * timing-safe by construction. We never short-circuit on hash shape or
 * length comparison — every verify runs through the full KDF.
 *
 * Hard rule: this module fails closed. Any error during `hash` or `verify`
 * propagates to the caller. We do NOT swallow exceptions and pretend the
 * password matched.
 */

import { hash, verify } from "@node-rs/argon2";

// Inline the value of @node-rs/argon2's `Algorithm.Argon2id` const enum.
// `isolatedModules` cannot read ambient const enum members across module
// boundaries, so we reference the raw integer here. The Rust side defines
// Argon2id = 2; if upstream changes that value, hashes minted with the wrong
// id won't verify and we'll see immediate test failures.
const ARGON2_ALGO_ID = 2;

/**
 * OWASP-aligned argon2id parameters. Tuned conservatively so cold boots on
 * modest hardware (the desktop app) don't stutter. If these change, write a
 * migration note — every existing hash in the DB still validates because
 * argon2 encodes its parameters in the hash string.
 */
export const ARGON2_PARAMS = {
  algorithm: ARGON2_ALGO_ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const PASSWORD_MIN_LENGTH = 12;

/** Result of {@link assertPasswordStrong}. */
export type PasswordStrengthFailureReason =
  | "too_short"
  | "missing_letter"
  | "missing_digit_or_symbol";

export class WeakPasswordError extends Error {
  readonly reason: PasswordStrengthFailureReason;
  constructor(reason: PasswordStrengthFailureReason) {
    super(`weak_password:${reason}`);
    this.name = "WeakPasswordError";
    this.reason = reason;
  }
}

/**
 * Refuse passwords under {@link PASSWORD_MIN_LENGTH} characters or with
 * trivially weak composition. We deliberately do not pull in `zxcvbn` to
 * avoid adding a runtime dep without explicit confirmation; the length +
 * composition floor is the documented fallback in the task brief.
 *
 * Throws {@link WeakPasswordError} on rejection.
 */
export function assertPasswordStrong(plain: string): void {
  if (typeof plain !== "string" || plain.length < PASSWORD_MIN_LENGTH) {
    throw new WeakPasswordError("too_short");
  }
  if (!/[A-Za-z]/.test(plain)) {
    throw new WeakPasswordError("missing_letter");
  }
  if (!/[0-9\W_]/.test(plain)) {
    throw new WeakPasswordError("missing_digit_or_symbol");
  }
}

/**
 * Hash `plain` with argon2id. Returns the encoded string (parameters + salt
 * + tag) suitable for direct DB storage.
 *
 * Errors propagate to the caller — fail-fast policy.
 */
export async function hashPassword(plain: string): Promise<string> {
  return await hash(plain, ARGON2_PARAMS);
}

/**
 * Compare `plain` against a stored argon2id hash. Returns `true` on match,
 * `false` on mismatch. Always runs the full KDF; never short-circuits.
 *
 * If the encoded hash is malformed or hashed with a different algorithm,
 * `@node-rs/argon2` throws — we propagate. The caller MUST treat a thrown
 * error as a verification failure (i.e., `await verifyPassword(...).catch(()
 * => false)` is wrong; let it surface).
 */
export async function verifyPassword(
  plain: string,
  encodedHash: string,
): Promise<boolean> {
  return await verify(encodedHash, plain);
}
