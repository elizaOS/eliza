/**
 * Steward request-signing helper for Feed server routes that call Steward
 * directly (mirrors @elizaos/cloud-shared/lib/steward/sign.ts).
 */

const REQUEST_TTL_SECONDS = 60;

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
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
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return bytesToHex(new Uint8Array(signature));
}

export async function buildStewardCanonicalRequest(
  method: string,
  pathAndSearch: string,
  headers: Headers,
  body: BufferSource,
): Promise<string> {
  const bodyHash = await sha256Hex(body);
  const authHash = await sha256TextHex(headers.get("authorization") ?? "");
  const apiKeyHash = await sha256TextHex(headers.get("x-steward-key") ?? "");
  const platformKeyHash = await sha256TextHex(
    headers.get("x-steward-platform-key") ?? "",
  );
  const signerIdHash = await sha256TextHex(
    headers.get("x-steward-signer-id") ?? "",
  );
  const signerSecretHash = await sha256TextHex(
    headers.get("x-steward-signer-secret") ?? "",
  );
  const quorumIdHash = await sha256TextHex(
    headers.get("x-steward-key-quorum-id") ?? "",
  );
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
  const canonical = await buildStewardCanonicalRequest(
    method,
    pathAndSearch,
    headers,
    body,
  );
  const signature = await hmacSha256Hex(secret, canonical);
  headers.set("x-steward-signature", `v1=${signature}`);
}
