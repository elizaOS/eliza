/**
 * Plaid webhook verification and classification for the finance back-end.
 *
 * Plaid signs every webhook with an ES256 JWT carried in the
 * `Plaid-Verification` header; the JWT payload pins the SHA-256 of the exact
 * request body and an `iat` freshness window. The verification key is looked
 * up by `kid` through Eliza Cloud (which holds the Plaid client credentials),
 * but the signature and body-hash checks happen here at the receiver, so a
 * forged or replayed delivery never reaches the sync path.
 *
 * Classification maps Plaid webhook codes onto the small set of actions the
 * FinancesService can take. Webhooks are treated as *hints*: duplicates and
 * out-of-order deliveries are safe because the actions they trigger (cursor
 * sync, needs_attention marking, disconnect cleanup) are idempotent.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { fail } from "./finance-normalize.ts";

const WEBHOOK_MAX_AGE_SECONDS = 5 * 60;
/** Signed `iat` values further in the future than this are rejected: a real
 * Plaid delivery is signed at send time, so a large forward skew is either a
 * badly broken clock or a captured-token replay staged for later. */
const WEBHOOK_MAX_FUTURE_SKEW_SECONDS = 60;
/** Upper bound on accepted webhook bodies. Plaid webhook payloads are small
 * JSON envelopes (well under 4 KiB); the cap exists so an unauthenticated
 * sender cannot make the receiver buffer arbitrary bytes. */
export const PLAID_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

export interface PlaidWebhookPayload {
  webhook_type: string;
  webhook_code: string;
  item_id: string;
  error?: { error_code?: string; error_message?: string } | null;
  [key: string]: unknown;
}

export type PlaidWebhookAction =
  /** Pull the transactions delta via /transactions/sync. */
  | "sync"
  /** Mark the source needs_attention and drive update-mode reauth. */
  | "reauth"
  /** The Item is gone upstream — run disconnect cleanup locally. */
  | "disconnect"
  /** Informational; record and ignore. */
  | "none";

const SYNC_CODES = new Set([
  "SYNC_UPDATES_AVAILABLE",
  "DEFAULT_UPDATE",
  "INITIAL_UPDATE",
  "HISTORICAL_UPDATE",
  "TRANSACTIONS_REMOVED",
  "RECURRING_TRANSACTIONS_UPDATE",
]);

const REAUTH_CODES = new Set([
  "ERROR",
  "PENDING_EXPIRATION",
  "PENDING_DISCONNECT",
  "LOGIN_REPAIRED",
]);

const DISCONNECT_CODES = new Set([
  "USER_PERMISSION_REVOKED",
  "USER_ACCOUNT_REVOKED",
]);

/** Maps a verified webhook onto the action the finance back-end should take. */
export function classifyPlaidWebhook(
  payload: PlaidWebhookPayload,
): PlaidWebhookAction {
  const code = payload.webhook_code;
  if (payload.webhook_type === "TRANSACTIONS" && SYNC_CODES.has(code)) {
    return "sync";
  }
  if (payload.webhook_type === "ITEM") {
    if (DISCONNECT_CODES.has(code)) {
      return "disconnect";
    }
    // LOGIN_REPAIRED clears the error state; ERROR/PENDING_EXPIRATION set it.
    if (REAUTH_CODES.has(code)) {
      return "reauth";
    }
  }
  return "none";
}

function decodeBase64UrlJson(segment: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch (error) {
    // error-policy:J2 malformed JWT segment becomes a typed 401 at this boundary.
    fail(401, `Plaid webhook JWT segment is not valid JSON: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(401, "Plaid webhook JWT segment is not an object.");
  }
  return parsed as Record<string, unknown>;
}

function parsePayloadBody(rawBody: string): PlaidWebhookPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (error) {
    // error-policy:J2 malformed upstream body becomes a typed 400.
    fail(400, `Plaid webhook body is not valid JSON: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(400, "Plaid webhook body is not an object.");
  }
  const body = parsed as Record<string, unknown>;
  if (
    typeof body.webhook_type !== "string" ||
    typeof body.webhook_code !== "string" ||
    typeof body.item_id !== "string"
  ) {
    fail(
      400,
      "Plaid webhook body is missing webhook_type/webhook_code/item_id.",
    );
  }
  return body as PlaidWebhookPayload;
}

export interface VerifyPlaidWebhookArgs {
  /** The exact raw request body bytes as received (hash is over these). */
  rawBody: string | Buffer;
  /** The `Plaid-Verification` request header (compact ES256 JWT). */
  verificationJwt: string;
  /** Key lookup by JWT `kid`, normally PlaidManagedClient.getWebhookVerificationKey. */
  getKey: (keyId: string) => Promise<{
    key: Record<string, unknown> & { expired_at?: number | null };
  }>;
  /** Injected clock for deterministic tests. */
  nowMs?: number;
}

/**
 * Verifies a Plaid webhook delivery and returns the parsed payload. Throws a
 * FinancesServiceError (401 for verification failures, 400 for malformed
 * bodies) — nothing partially-verified escapes.
 */
export async function verifyPlaidWebhook(
  args: VerifyPlaidWebhookArgs,
): Promise<PlaidWebhookPayload> {
  const segments = args.verificationJwt.split(".");
  if (segments.length !== 3) {
    fail(401, "Plaid-Verification header is not a compact JWT.");
  }
  const [headerB64, payloadB64, signatureB64] = segments;
  const header = decodeBase64UrlJson(headerB64);
  if (header.alg !== "ES256") {
    fail(401, `Plaid webhook JWT uses unsupported alg ${String(header.alg)}.`);
  }
  if (typeof header.kid !== "string" || header.kid.length === 0) {
    fail(401, "Plaid webhook JWT is missing a key id.");
  }
  const { key } = await args.getKey(header.kid);
  if (key.expired_at !== undefined && key.expired_at !== null) {
    fail(401, "Plaid webhook verification key is expired.");
  }
  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await globalThis.crypto.subtle.importKey(
      "jwk",
      key as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch (error) {
    // error-policy:J2 an unusable upstream JWK becomes a typed 401.
    fail(401, `Plaid webhook verification key is invalid: ${String(error)}`);
  }
  const valid = await globalThis.crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    cryptoKey,
    Buffer.from(signatureB64, "base64url"),
    Buffer.from(`${headerB64}.${payloadB64}`, "utf8"),
  );
  if (!valid) {
    fail(401, "Plaid webhook signature verification failed.");
  }
  const claims = decodeBase64UrlJson(payloadB64);
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  const nowSeconds = Math.floor((args.nowMs ?? Date.now()) / 1000);
  if (iat === null || nowSeconds - iat > WEBHOOK_MAX_AGE_SECONDS) {
    fail(401, "Plaid webhook JWT is missing iat or is too old (replay).");
  }
  if (iat - nowSeconds > WEBHOOK_MAX_FUTURE_SKEW_SECONDS) {
    fail(401, "Plaid webhook JWT iat is too far in the future (clock skew).");
  }
  const expectedBodyHash = claims.request_body_sha256;
  if (typeof expectedBodyHash !== "string" || expectedBodyHash.length === 0) {
    fail(401, "Plaid webhook JWT is missing request_body_sha256.");
  }
  const rawBodyBytes =
    typeof args.rawBody === "string"
      ? Buffer.from(args.rawBody, "utf8")
      : args.rawBody;
  const actualBodyHash = createHash("sha256")
    .update(rawBodyBytes)
    .digest("hex");
  const actualHashBytes = Buffer.from(actualBodyHash, "utf8");
  const expectedHashBytes = Buffer.from(expectedBodyHash, "utf8");
  if (
    actualHashBytes.length !== expectedHashBytes.length ||
    !timingSafeEqual(actualHashBytes, expectedHashBytes)
  ) {
    fail(401, "Plaid webhook body hash does not match the signed hash.");
  }
  return parsePayloadBody(rawBodyBytes.toString("utf8"));
}
