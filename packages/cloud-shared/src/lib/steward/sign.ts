/**
 * Steward request-signing helper for callers that bypass the `/steward/*`
 * proxy in cloud-api's `bootstrap-app.ts` and talk to upstream Steward
 * directly: the OAuth nonce-exchange route, the steward-refresh bypass, and
 * the provisioning daemon's agent registration / cleanup calls.
 *
 * Steward's `authorization-signature` middleware
 * (Steward-Fi/steward: packages/api/src/middleware/authorization-signature.ts)
 * is the AUTHORITATIVE definition of the canonical request. cloud-api's
 * `embedded.ts` mirrors it for the proxy path; this module mirrors it for
 * every direct-path caller. All copies MUST stay byte-for-byte in lockstep —
 * if upstream adds, removes, or reorders a header the canonical hashes,
 * update every copy together or signed requests start returning 401. Keep
 * this list identical to `buildStewardCanonicalRequest` in `embedded.ts`.
 */

// Matches embedded.ts: a short freshness window for the X-Steward-Request-*
// header, well inside Steward's ±5min skew/TTL tolerance.
const REQUEST_TTL_SECONDS = 60;

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

async function sha256Hex(input: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", input);
  return bytesToHex(new Uint8Array(digest));
}

async function sha256TextHex(value: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(value));
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToHex(new Uint8Array(signature));
}

/**
 * Build the exact ordered canonical string Steward HMACs. Keep in lockstep
 * with `buildStewardCanonicalRequest` in `embedded.ts` and `canonicalRequest`
 * in Steward's authorization-signature middleware.
 */
export async function buildStewardCanonicalRequest(
  method: string,
  pathAndSearch: string,
  headers: Headers,
  body: BufferSource,
): Promise<string> {
  const bodyHash = await sha256Hex(body);
  const authHash = await sha256TextHex(headers.get("authorization") ?? "");
  const apiKeyHash = await sha256TextHex(headers.get("x-steward-key") ?? "");
  const platformKeyHash = await sha256TextHex(headers.get("x-steward-platform-key") ?? "");
  const signerIdHash = await sha256TextHex(headers.get("x-steward-signer-id") ?? "");
  const signerSecretHash = await sha256TextHex(headers.get("x-steward-signer-secret") ?? "");
  const quorumIdHash = await sha256TextHex(headers.get("x-steward-key-quorum-id") ?? "");
  const quorumCredentialsHash = await sha256TextHex(
    headers.get("x-steward-key-quorum-credentials") ?? "",
  );
  return [
    "steward-request-signature-v1",
    method.toUpperCase(),
    pathAndSearch,
    headers.get("x-steward-tenant") ?? "",
    authHash,
    apiKeyHash,
    platformKeyHash,
    signerIdHash,
    signerSecretHash,
    quorumIdHash,
    quorumCredentialsHash,
    headers.get("x-steward-request-timestamp") ?? "",
    headers.get("x-steward-request-expires-at") ?? "",
    headers.get("idempotency-key") ?? "",
    bodyHash,
  ].join("\n");
}

/**
 * Apply Steward's freshness + HMAC signature headers to `headers` in place for
 * a mutating upstream request. Sets `X-Steward-Request-Expires-At`, an
 * `Idempotency-Key` (preserving any caller-supplied one — Steward's idempotency
 * middleware requires it on every signed mutating request), and
 * `X-Steward-Signature: v1=<hex>`.
 *
 * `pathAndSearch` and `headers` MUST match what is actually sent upstream, and
 * `body` MUST be the exact bytes of the request body, or the signature won't
 * verify.
 */
export async function signStewardMutatingRequest(
  secret: string,
  method: string,
  pathAndSearch: string,
  headers: Headers,
  body: BufferSource,
): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1000) + REQUEST_TTL_SECONDS;
  headers.set("x-steward-request-expires-at", String(expiresAt));
  if (!headers.get("idempotency-key")) {
    headers.set("idempotency-key", crypto.randomUUID());
  }
  const canonical = await buildStewardCanonicalRequest(method, pathAndSearch, headers, body);
  const signature = await hmacSha256Hex(secret, canonical);
  headers.set("x-steward-signature", `v1=${signature}`);
}
