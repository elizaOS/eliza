/**
 * Single source of truth for decoding a Steward JWT payload in the browser.
 *
 * The cloud surfaces only ever inspect the *unverified* payload (its `exp` plus
 * a few identity claims) to decide whether a locally stored session still looks
 * live before the server confirms it. Signature verification is the server's
 * job. Every cloud domain delegates here so the null/expired semantics stay
 * identical across surfaces.
 */

/** Claims the cloud surfaces read off a Steward session token. */
export interface StewardTokenClaims {
  exp?: number;
  userId?: string;
  sub?: string;
  email?: string;
  address?: string;
}

/**
 * Base64url-decode and JSON-parse the payload (second segment) of a JWT.
 * Returns `null` for any malformed token (wrong segment count, bad base64,
 * invalid JSON) so callers treat "can't read it" as "no session".
 */
export function decodeJwtPayload(token: string): StewardTokenClaims | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "=",
    );
    // `atob` yields one char per BYTE (latin1). JWT payloads are UTF-8 JSON
    // (RFC 7519 §3), so parse the bytes through a UTF-8 decode — feeding the
    // byte string straight to JSON.parse mojibakes any non-ASCII claim
    // ("josé" → "josÃ©"). `fatal: true` makes non-UTF-8 bytes throw, which the
    // catch maps to the contract's `null` for malformed tokens.
    const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(json) as StewardTokenClaims;
  } catch {
    // error-policy:J3 malformed JWT reads as the explicit "no claims" null —
    // callers treat it as an invalid/expired token (fail-closed).
    return null;
  }
}

/** Milliseconds-since-epoch the token expires, or `null` when it has no `exp`. */
export function jwtExpiryMs(token: string): number | null {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") return null;
  return payload.exp * 1000;
}
