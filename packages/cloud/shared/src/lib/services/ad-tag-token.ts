/**
 * Signed ad-tag tokens for the public SSP serve endpoint (#10687).
 *
 * The serve endpoint is public (the miniapp ad tag calls it from end-user
 * browsers) but it moves money — every fill debits an advertiser campaign and
 * accrues a publisher payout. A bare slot id is guessable/leakable, so serving
 * requires a token minted for the slot when the publisher creates/fetches it:
 * an HMAC-SHA256 (keyed by `ELIZA_AD_TAG_SECRET`) over the slot id, the app id,
 * and an expiry. Without the secret configured, minting and verification both
 * fail closed — the public serve path stays off.
 *
 * Token format: `v1.<expiresAtEpochSeconds>.<hmacHex>`.
 */

const AD_TAG_CANONICAL_PREFIX = "eliza-ad-tag-v1";
/** Default token lifetime: ad tags are embedded in published app surfaces. */
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function signingSecret(): string | null {
  const secret = process.env.ELIZA_AD_TAG_SECRET;
  return secret && secret.trim().length > 0 ? secret : null;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalMessage(slotId: string, appId: string, expiresAt: number): string {
  return `${AD_TAG_CANONICAL_PREFIX}\n${slotId}\n${appId}\n${expiresAt}`;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Mint the ad-tag token for a slot. Returns null when `ELIZA_AD_TAG_SECRET`
 * is not configured (serving is then disabled — fail closed).
 */
export async function mintAdTagToken(input: {
  slotId: string;
  appId: string;
  ttlSeconds?: number;
}): Promise<string | null> {
  const secret = signingSecret();
  if (!secret) return null;
  const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const signature = await hmacHex(secret, canonicalMessage(input.slotId, input.appId, expiresAt));
  return `v1.${expiresAt}.${signature}`;
}

/**
 * Verify an ad-tag token against the slot it claims to serve. False on any
 * failure: missing secret (fail closed), malformed token, expiry in the past,
 * or a signature that does not match this exact (slotId, appId, expiry).
 */
export async function verifyAdTagToken(
  token: string,
  input: { slotId: string; appId: string },
): Promise<boolean> {
  const secret = signingSecret();
  if (!secret) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return false;
  if (expiresAt * 1000 < Date.now()) return false;
  const expected = await hmacHex(secret, canonicalMessage(input.slotId, input.appId, expiresAt));
  return timingSafeEqualHex(parts[2], expected);
}
