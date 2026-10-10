/**
 * Webhook signature verification — for consumers receiving HMAC-signed events.
 *
 * Server side (packages/webhooks/dispatcher.ts) signs with HMAC-SHA-256 over a
 * versioned canonical string and ships the digest in `X-Steward-Signature`.
 *
 * Scheme v2 (current): the header value is `v2=<hex>` and the signed material is
 *   `v2:${timestamp}.${deliveryId}.${eventType}.${body}`
 * binding the dispatch timestamp, a stable per-delivery nonce (`X-Steward-Delivery-Id`)
 * and the event type (`X-Steward-Event`) into the HMAC. This prevents replaying a
 * captured/persisted event with a tampered event type, and deliveryId is stable across retries while each attempt gets a fresh timestamp.
 *
 * Legacy (backward-compat, opt-in): a bare hex digest over `${timestamp}.${body}`
 * or — with `allowLegacyBodySignature` — the raw body. Body-only signatures have no
 * replay protection. Retained only for receivers still on the old scheme.
 *
 * Both sign and verify paths use only the Web Crypto / Subtle Crypto APIs
 * so the helper works in browsers, Workers, and Node 20+ without any
 * runtime-specific code paths.
 */

import {
  canonicalSignedPayload,
  hmacSha256Hex,
  SIGNATURE_SCHEME,
} from "../contracts/index";

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.toLowerCase().replace(/^0x/, "");
  if (normalized.length === 0 || normalized.length % 2 !== 0)
    return new Uint8Array(0);
  if (!/^[0-9a-f]+$/.test(normalized)) return new Uint8Array(0);
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    out[i / 2] = parseInt(normalized.slice(i, i + 2), 16);
  }
  return out;
}

/** Constant-time byte-array equality. Always reads both arrays to the end. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Compute the canonical hex signature for `body` with `secret`. Exposed so
 * tests and self-checks can produce expected values without re-implementing
 * the HMAC details.
 */
export async function signWebhookPayload(
  body: string,
  secret: string,
): Promise<string> {
  return hmacSha256Hex(secret, body);
}

export interface VerifyWebhookOptions {
  /** Maximum age in seconds. Default 300 (5 minutes). Set Infinity to skip. */
  toleranceSec?: number;
  /** Defaults to Date.now()/1000 — injectable for deterministic testing. */
  nowSec?: number;
  /**
   * Accept legacy signatures computed over the raw body when no timestamp is
   * present. Body-only signatures have no replay protection.
   */
  allowLegacyBodySignature?: boolean;
  /**
   * Accept the pre-v2 `${timestamp}.${body}` scheme (no nonce/event binding).
   * Defaults to FALSE: the legacy scheme has no nonce/event binding and is a pure
   * downgrade risk now that the dispatcher only emits v2. Set to `true` only for a
   * documented external sender that has not yet migrated to v2.
   */
  allowLegacyTimestampSignature?: boolean;
  /** Event type from `X-Steward-Event`. Required to verify a v2 signature. */
  eventType?: string | null;
  /** Stable delivery id (nonce) from `X-Steward-Delivery-Id`. Required for v2. */
  deliveryId?: string | null;
}

export interface VerifyWebhookResult {
  valid: boolean;
  /** Set when `valid` is false. Coarse enum so callers can log without leaking detail. */
  reason?:
    | "missing-signature"
    | "bad-signature"
    | "stale-timestamp"
    | "bad-timestamp";
  /** Signature scheme that verified (when valid). */
  scheme?: "v2" | "legacy-timestamp" | "legacy-body";
  /** Stable delivery id (nonce); use to dedup replays. Present for v2. */
  deliveryId?: string;
}

/**
 * Verify an inbound webhook against the shared secret. The `signature` arg
 * is the raw value of `X-Steward-Signature`; `timestamp` is the optional
 * `X-Steward-Timestamp` header. `body` MUST be the raw request body as the
 * server saw it — re-serialized JSON will not match because key ordering
 * and whitespace differ.
 */
export async function verifyWebhookSignature(
  body: string,
  signature: string | null | undefined,
  secret: string,
  timestamp?: string | number | null,
  options: VerifyWebhookOptions = {},
): Promise<VerifyWebhookResult> {
  if (!signature || typeof signature !== "string") {
    return { valid: false, reason: "missing-signature" };
  }

  // Fail closed on a blank secret instead of throwing from WebCrypto
  // (a zero-length HMAC key raises DataError). The server-side verifier
  // (server/webhooks/verify.ts) rejects a blank secret the same way.
  if (typeof secret !== "string" || !secret.trim()) {
    return { valid: false, reason: "bad-signature" };
  }

  if (timestamp !== undefined && timestamp !== null) {
    // The dispatcher emits canonical non-negative integer unix seconds
    // (Math.floor(Date.now() / 1000).toString()) and signs that exact
    // string. Accept only that form, as the server-side verifier does:
    // a loose Number() parse also accepted decimals, exponents, padding,
    // and leading zeros, widening the signed scheme.
    const tsNum =
      typeof timestamp === "number"
        ? timestamp
        : /^(?:0|[1-9]\d*)$/.test(timestamp)
          ? Number(timestamp)
          : Number.NaN;
    if (!Number.isSafeInteger(tsNum) || tsNum < 0) {
      return { valid: false, reason: "bad-timestamp" };
    }
    const tolerance = options.toleranceSec ?? 300;
    // Fail closed on an invalid tolerance: NaN previously made
    // Number.isFinite skip the freshness check entirely, silently
    // disabling replay protection. Infinity still skips by design.
    if (
      tolerance !== Number.POSITIVE_INFINITY &&
      (!Number.isFinite(tolerance) || tolerance < 0)
    ) {
      return { valid: false, reason: "bad-timestamp" };
    }
    if (Number.isFinite(tolerance)) {
      const now = options.nowSec ?? Math.floor(Date.now() / 1000);
      if (!Number.isFinite(now) || now < 0) {
        return { valid: false, reason: "bad-timestamp" };
      }
      if (Math.abs(now - tsNum) > tolerance) {
        return { valid: false, reason: "stale-timestamp" };
      }
    }
  }

  // A `v2=` prefix selects the versioned, nonce/event-bound scheme exclusively.
  const schemePrefix = `${SIGNATURE_SCHEME}=`;
  if (signature.startsWith(schemePrefix)) {
    // The dispatcher emits exactly 64 lowercase hex chars (hmacSha256Hex).
    // Match the server-side verifier: no 0x prefix, no uppercase, no
    // other lengths.
    const providedHex = signature.slice(schemePrefix.length);
    if (!/^[0-9a-f]{64}$/.test(providedHex))
      return { valid: false, reason: "bad-signature" };
    const provided = hexToBytes(providedHex);
    if (timestamp === undefined || timestamp === null) {
      return { valid: false, reason: "bad-timestamp" };
    }
    const deliveryId = options.deliveryId;
    const eventType = options.eventType;
    if (!deliveryId?.trim() || !eventType?.trim())
      return { valid: false, reason: "bad-signature" };
    // Length-prefix deliveryId/eventType so field boundaries cannot be shifted
    // (event types and bodies contain '.'); must match dispatcher.canonicalSignedPayload.
    const canonical = canonicalSignedPayload(
      String(timestamp),
      deliveryId,
      eventType,
      body,
    );
    const expected = hexToBytes(await signWebhookPayload(canonical, secret));
    if (constantTimeEqual(provided, expected)) {
      return { valid: true, scheme: "v2", deliveryId };
    }
    return { valid: false, reason: "bad-signature" };
  }

  // Legacy bare-hex paths (no scheme prefix).
  const candidates: {
    material: string;
    scheme: VerifyWebhookResult["scheme"];
  }[] = [];
  if (timestamp !== undefined && timestamp !== null) {
    if (options.allowLegacyTimestampSignature === true) {
      candidates.push({
        material: `${timestamp}.${body}`,
        scheme: "legacy-timestamp",
      });
    }
  } else if (options.allowLegacyBodySignature === true) {
    candidates.push({ material: body, scheme: "legacy-body" });
  }

  const provided = hexToBytes(signature);
  if (provided.length === 0) return { valid: false, reason: "bad-signature" };
  if (candidates.length === 0) return { valid: false, reason: "bad-timestamp" };

  for (const candidate of candidates) {
    const expectedHex = await signWebhookPayload(candidate.material, secret);
    const expected = hexToBytes(expectedHex);
    if (constantTimeEqual(provided, expected)) {
      return { valid: true, scheme: candidate.scheme };
    }
  }
  return { valid: false, reason: "bad-signature" };
}
