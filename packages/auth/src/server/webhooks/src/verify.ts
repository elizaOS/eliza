import { createHmac, timingSafeEqual } from "node:crypto";

import { canonicalSignedPayload } from "./dispatcher";

/**
 * Receiver-side input for {@link verifyWebhookSignature}: the Steward delivery
 * headers plus the raw request body, exactly as received.
 */
export interface VerifyWebhookSignatureInput {
  /** Raw, unparsed request body (the exact bytes Steward signed). */
  body: string;
  /** `X-Steward-Delivery-Id` header. */
  deliveryId: string;
  /** `X-Steward-Event` header. */
  eventType: string;
  /** `X-Steward-Sent-At` header (unix seconds). */
  sentAt: string;
  /** `X-Steward-Signature` header (`v2=<hex>`). */
  signature: string;
  /** The webhook's signing secret. */
  secret: string;
  /** Maximum sender/receiver clock skew in seconds. Default 300 (5 minutes). */
  toleranceSeconds?: number;
  /** Current time in unix seconds (injectable for tests). */
  nowSeconds?: number;
}

/**
 * Receiver-side verification for Steward's v2 webhook signature scheme
 * (SEC-177).
 *
 * Recomputes HMAC-SHA256 over the canonical signed payload (scheme version,
 * freshness timestamp, length-prefixed deliveryId + eventType, raw body) and
 * compares with `crypto.timingSafeEqual` — NEVER `===`, which leaks prefix
 * length through timing. Also enforces a freshness window on
 * `X-Steward-Sent-At` so a captured signature cannot be replayed outside the
 * tolerance.
 *
 * Fails closed: returns false on any malformed input; never throws.
 */
export function verifyWebhookSignature(
  input: VerifyWebhookSignatureInput,
): boolean {
  try {
    const tolerance = input.toleranceSeconds ?? 300;
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);

    // Only canonical non-negative integer unix seconds are emitted. Reject
    // decimals/exponents and invalid verifier options so NaN/Infinity cannot
    // turn the freshness comparison into a silent pass.
    if (!/^(?:0|[1-9]\d*)$/.test(input.sentAt)) return false;
    const sentAtSeconds = Number(input.sentAt);
    if (!Number.isSafeInteger(sentAtSeconds)) return false;
    if (!Number.isSafeInteger(tolerance) || tolerance < 0) return false;
    if (!Number.isSafeInteger(now) || now < 0) return false;
    if (Math.abs(now - sentAtSeconds) > tolerance) return false;

    // The signed material is only meaningful with real field values; an empty
    // delivery id or event type would verify an attacker-shaped payload.
    if (
      !input.deliveryId.trim() ||
      !input.eventType.trim() ||
      !input.secret.trim()
    )
      return false;

    if (!input.signature.startsWith("v2=")) return false;
    const providedHex = input.signature.slice(3);
    if (!/^[0-9a-f]{64}$/.test(providedHex)) return false;

    const expected = createHmac("sha256", input.secret)
      .update(
        canonicalSignedPayload(
          input.sentAt,
          input.deliveryId,
          input.eventType,
          input.body,
        ),
      )
      .digest();
    const provided = Buffer.from(providedHex, "hex");
    return (
      expected.length === provided.length && timingSafeEqual(expected, provided)
    );
  } catch {
    return false;
  }
}
