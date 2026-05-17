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
/**
 * OWASP-aligned argon2id parameters. Tuned conservatively so cold boots on
 * modest hardware (the desktop app) don't stutter. If these change, write a
 * migration note — every existing hash in the DB still validates because
 * argon2 encodes its parameters in the hash string.
 */
export declare const ARGON2_PARAMS: {
  readonly algorithm: 2;
  readonly memoryCost: 19456;
  readonly timeCost: 2;
  readonly parallelism: 1;
};
export declare const PASSWORD_MIN_LENGTH = 12;
/** Result of {@link assertPasswordStrong}. */
export type PasswordStrengthFailureReason =
  | "too_short"
  | "missing_letter"
  | "missing_digit_or_symbol";
export declare class WeakPasswordError extends Error {
  readonly reason: PasswordStrengthFailureReason;
  constructor(reason: PasswordStrengthFailureReason);
}
/**
 * Refuse passwords under {@link PASSWORD_MIN_LENGTH} characters or with
 * trivially weak composition. We deliberately do not pull in `zxcvbn` to
 * avoid adding a runtime dep without explicit confirmation; the length +
 * composition floor is the documented fallback in the task brief.
 *
 * Throws {@link WeakPasswordError} on rejection.
 */
export declare function assertPasswordStrong(plain: string): void;
/**
 * Hash `plain` with argon2id. Returns the encoded string (parameters + salt
 * + tag) suitable for direct DB storage.
 *
 * Errors propagate to the caller — fail-fast policy.
 */
export declare function hashPassword(plain: string): Promise<string>;
/**
 * Compare `plain` against a stored argon2id hash. Returns `true` on match,
 * `false` on mismatch. Always runs the full KDF; never short-circuits.
 *
 * If the encoded hash is malformed or hashed with a different algorithm,
 * `@node-rs/argon2` throws — we propagate. The caller MUST treat a thrown
 * error as a verification failure (i.e., `await verifyPassword(...).catch(()
 * => false)` is wrong; let it surface).
 */
export declare function verifyPassword(
  plain: string,
  encodedHash: string,
): Promise<boolean>;
//# sourceMappingURL=passwords.d.ts.map
