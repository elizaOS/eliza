/**
 * SIWE-guard — defensive validators that go beyond bare `siwe` library checks.
 *
 * The base `siwe` package verifies the signature and the canonical message
 * format. It does NOT check:
 *   1. whether the `domain` field is one your server actually serves,
 *   2. whether `chainId` is in your allowed set,
 *   3. whether the `notBefore` / `expirationTime` window is sane (a
 *      pathologically long-lived signature is technically valid; a missing
 *      expirationTime falls back to bounding the message's issuedAt age, and
 *      a future-dated issuedAt is rejected),
 *   4. whether the `statement` matches a server-side allowlist (defends
 *      against phishing sites tricking users into signing your messages),
 *   5. whether `uri` matches `domain` (some wallets fail to enforce this).
 *
 * This module supplies all five as a single `evaluateSiwePolicy` call that
 * inspects an already-parsed SIWE message and returns the first violation
 * it finds, or `null` for "passes policy." It does NOT verify the signature
 * itself — that remains the responsibility of the calling auth route.
 */

export interface SiweMessageLike {
  domain: string;
  address: string;
  statement?: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
  notBefore?: string;
}

export interface SiwePolicy {
  /** Exact-match allowlist of acceptable `domain` values. Required. */
  allowedDomains: readonly string[];
  /** Allowed chainIds. Empty array allows none; omit to allow any. */
  allowedChainIds?: readonly number[];
  /** Required exact-match `statement`. Set to skip statement check. */
  requiredStatement?: string;
  /** Maximum lifetime (issuedAt → expirationTime), in milliseconds. Default 10 minutes. */
  maxLifetimeMs?: number;
  /** Maximum clock skew tolerated for notBefore/issuedAt, in ms. Default 30s. */
  clockSkewMs?: number;
  /** Override clock for tests. */
  now?: () => Date;
}

export type SiweViolation =
  | "domain-not-allowed"
  | "chain-not-allowed"
  | "statement-mismatch"
  | "uri-domain-mismatch"
  | "version-unsupported"
  | "expired"
  | "not-yet-valid"
  | "lifetime-too-long"
  | "missing-nonce";

export function evaluateSiwePolicy(
  msg: SiweMessageLike,
  policy: SiwePolicy,
): SiweViolation | null {
  const now = policy.now ? policy.now() : new Date();
  const clockSkewMs = policy.clockSkewMs ?? 30_000;
  const maxLifetimeMs = policy.maxLifetimeMs ?? 10 * 60_000;

  if (msg.version !== "1") return "version-unsupported";

  if (!msg.nonce || msg.nonce.length < 8) return "missing-nonce";

  if (!policy.allowedDomains.includes(msg.domain)) {
    return "domain-not-allowed";
  }

  // The `uri` should be hosted at the same domain we just validated. Wallets
  // generally enforce this but not all do, so we check.
  try {
    const uri = new URL(msg.uri);
    if (uri.host !== msg.domain) return "uri-domain-mismatch";
  } catch {
    return "uri-domain-mismatch";
  }

  if (policy.allowedChainIds !== undefined) {
    if (!policy.allowedChainIds.includes(msg.chainId))
      return "chain-not-allowed";
  }

  if (
    policy.requiredStatement !== undefined &&
    msg.statement !== policy.requiredStatement
  ) {
    return "statement-mismatch";
  }

  const issuedAt = Date.parse(msg.issuedAt);
  if (!Number.isFinite(issuedAt)) return "not-yet-valid";
  // A future-dated issuedAt is never acceptable beyond clock skew (SEC-065).
  if (issuedAt - now.getTime() > clockSkewMs) return "not-yet-valid";

  if (msg.notBefore) {
    const nb = Date.parse(msg.notBefore);
    if (Number.isFinite(nb) && nb - now.getTime() > clockSkewMs) {
      return "not-yet-valid";
    }
  }

  if (msg.expirationTime) {
    const exp = Date.parse(msg.expirationTime);
    if (Number.isFinite(exp)) {
      if (exp + clockSkewMs < now.getTime()) return "expired";
      if (exp - issuedAt > maxLifetimeMs) return "lifetime-too-long";
    }
  } else if (now.getTime() - issuedAt > maxLifetimeMs) {
    // No expirationTime: bound the temporal window by the message's age
    // instead, so a signed login cannot stay valid forever (SEC-065).
    return "lifetime-too-long";
  }

  return null;
}
