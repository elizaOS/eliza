/**
 * Discord Activity OAuth state token generation and verification.
 * Extracted from route so the route file only exports the GET handler.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** State tokens are valid for 5 minutes. */
export const STATE_TTL_SECONDS = 300;

/**
 * Derive a signing key from the Discord client secret.
 * Uses HMAC-SHA256 with a domain-specific prefix to avoid key reuse.
 */
function deriveSigningKey(clientSecret: string): Buffer {
  return createHmac("sha256", "discord-activity-oauth-state")
    .update(clientSecret)
    .digest();
}

/**
 * Generate a signed state token.
 *
 * @returns The signed state string in `uuid.timestamp.signature` format
 */
export function generateSignedState(clientSecret: string): string {
  const nonce = crypto.randomUUID();
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${nonce}.${timestamp}`;
  const key = deriveSigningKey(clientSecret);
  const signature = createHmac("sha256", key).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

/**
 * Verify a signed state token.
 *
 * @returns true if the signature is valid and the token has not expired
 */
export function verifySignedState(
  state: string,
  clientSecret: string,
): { valid: boolean; reason?: string } {
  const parts = state.split(".");
  if (parts.length !== 3) {
    return { valid: false, reason: "malformed state token" };
  }

  const nonce = parts[0]!;
  const timestampStr = parts[1]!;
  const providedSignature = parts[2]!;

  // Validate UUID format for the nonce
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(nonce)) {
    return { valid: false, reason: "invalid nonce format" };
  }

  // Validate and check timestamp
  const timestamp = Number.parseInt(timestampStr, 10);
  if (Number.isNaN(timestamp)) {
    return { valid: false, reason: "invalid timestamp" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (now - timestamp > STATE_TTL_SECONDS) {
    return { valid: false, reason: "state token expired" };
  }

  // Reject tokens issued in the future (clock skew tolerance: 30s)
  if (timestamp > now + 30) {
    return { valid: false, reason: "state token issued in the future" };
  }

  // Recompute HMAC and compare using timing-safe comparison
  const payload = `${nonce}.${timestampStr}`;
  const key = deriveSigningKey(clientSecret);
  const expectedSignature = createHmac("sha256", key)
    .update(payload)
    .digest("hex");

  if (providedSignature.length !== expectedSignature.length) {
    return { valid: false, reason: "signature mismatch" };
  }

  // Timing-safe comparison via Buffer
  const a = Buffer.from(providedSignature, "hex");
  const b = Buffer.from(expectedSignature, "hex");
  if (a.length !== b.length) {
    return { valid: false, reason: "signature mismatch" };
  }

  if (!timingSafeEqual(a, b)) {
    return { valid: false, reason: "signature mismatch" };
  }

  return { valid: true };
}
