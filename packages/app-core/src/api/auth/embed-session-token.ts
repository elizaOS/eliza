/**
 * Scoped embed session token (#9947) — the credential minted from a verified
 * embed-launch principal.
 *
 * A cross-origin embedded surface (Discord Activity / Telegram Mini App iframe)
 * cannot use the first-party Steward cookie, so after `verifyEmbedLaunch`
 * succeeds the server mints this self-contained, HMAC-signed bearer token that
 * the embedded SPA presents on its API calls. It carries only the verified
 * `entityId` + `role` + `adminMode` claim and a short expiry — no ambient
 * authority. It is signed with a server secret and verified the same way, so a
 * tampered or expired token fails closed.
 *
 *   token = base64url(JSON(claims)) + "." + base64url(HMAC_SHA256(secret, payload))
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type EmbedSessionRole = "OWNER" | "ADMIN";

export interface EmbedSessionClaims {
  /** The account-scoped Eliza entity the verified platform user maps to. */
  entityId: string;
  /** Verified role (only OWNER/ADMIN are ever minted). */
  role: EmbedSessionRole;
  /** Whether the embedded surface runs in ADMIN mode. */
  adminMode: boolean;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

/** Default token lifetime (1 hour) — short by design; the embed re-launches. */
export const DEFAULT_EMBED_TOKEN_TTL_MS = 60 * 60 * 1000;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function mintEmbedSessionToken(
  claims: EmbedSessionClaims,
  secret: string,
): string {
  if (!secret) {
    throw new Error("embed session secret is required to mint a token");
  }
  const payload = base64url(JSON.stringify(claims));
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Verify a token and return its claims, or `null` when the signature is invalid,
 * the token is malformed, or it has expired. Fails closed in every case.
 */
export function verifyEmbedSessionToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): EmbedSessionClaims | null {
  if (!token || !secret) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  const expectedSig = sign(payload, secret);
  const provided = Buffer.from(providedSig);
  const expected = Buffer.from(expectedSig);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return null;
  }

  let claims: EmbedSessionClaims;
  try {
    claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as EmbedSessionClaims;
  } catch {
    return null;
  }
  if (
    typeof claims.entityId !== "string" ||
    (claims.role !== "OWNER" && claims.role !== "ADMIN") ||
    typeof claims.exp !== "number"
  ) {
    return null;
  }
  if (now >= claims.exp) {
    return null;
  }
  return claims;
}
