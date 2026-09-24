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
 * captured/persisted event with a tampered event type, and the deliveryId + timestamp
 * are stable across retries so consumers can dedup replays within the tolerance window.
 *
 * Legacy (backward-compat, opt-in): a bare hex digest over `${timestamp}.${body}`
 * or — with `allowLegacyBodySignature` — the raw body. Body-only signatures have no
 * replay protection. Retained only for receivers still on the old scheme.
 *
 * Both sign and verify paths use only the Web Crypto / Subtle Crypto APIs
 * so the helper works in browsers, Workers, and Node 20+ without any
 * runtime-specific code paths.
 */

const encoder = new TextEncoder();
const SIGNATURE_SCHEME = "v2";

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

function bytesToHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, "0");
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

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const secretBytes = encoder.encode(secret);
  return crypto.subtle.importKey(
    "raw",
    secretBytes.buffer.slice(
      secretBytes.byteOffset,
      secretBytes.byteOffset + secretBytes.byteLength,
    ) as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
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
  const key = await importHmacKey(secret);
  const bytes = encoder.encode(body);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  return bytesToHex(sig);
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

  if (timestamp !== undefined && timestamp !== null) {
    const tsNum = typeof timestamp === "number" ? timestamp : Number(timestamp);
    if (!Number.isFinite(tsNum)) {
      return { valid: false, reason: "bad-timestamp" };
    }
    const tolerance = options.toleranceSec ?? 300;
    if (Number.isFinite(tolerance)) {
      const now = options.nowSec ?? Math.floor(Date.now() / 1000);
      if (Math.abs(now - tsNum) > tolerance) {
        return { valid: false, reason: "stale-timestamp" };
      }
    }
  }

  // A `v2=` prefix selects the versioned, nonce/event-bound scheme exclusively.
  const schemePrefix = `${SIGNATURE_SCHEME}=`;
  if (signature.startsWith(schemePrefix)) {
    const provided = hexToBytes(signature.slice(schemePrefix.length));
    if (provided.length === 0) return { valid: false, reason: "bad-signature" };
    if (timestamp === undefined || timestamp === null) {
      return { valid: false, reason: "bad-timestamp" };
    }
    const deliveryId = options.deliveryId;
    const eventType = options.eventType;
    if (!deliveryId || !eventType)
      return { valid: false, reason: "bad-signature" };
    // Length-prefix deliveryId/eventType so field boundaries cannot be shifted
    // (event types and bodies contain '.'); must match dispatcher.canonicalSignedPayload.
    const canonical = `${SIGNATURE_SCHEME}:${timestamp}.${deliveryId.length}:${deliveryId}.${eventType.length}:${eventType}.${body}`;
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
