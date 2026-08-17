/**
 * Mints and verifies short-lived, tenant-scoped capabilities for private R2
 * reads served by the Cloudflare Worker. The token is authenticated but not
 * encrypted, fits in one URL path segment, and binds the exact host, method,
 * object key, purpose, and validity window that the Worker will honor.
 */

const TOKEN_VERSION = "v1";
const CLAIMS_VERSION = 1 as const;
const PURPOSE = "storage-read" as const;
const CAPABILITY_METHOD = "GET" as const;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3600;
const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 1024;
const MAX_SECRET_COUNT = 8;
const MAX_RAW_SECRETS_BYTES = 8192;
const MAX_HOST_LENGTH = 253;
const MAX_SCOPED_KEY_BYTES = 1024;
const MAX_TOKEN_LENGTH = 4096;
const MAX_PAYLOAD_LENGTH = 3072;
const HMAC_SIGNATURE_BYTES = 32;

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** Stable, public path prefix used by both the signer and blob-host handler. */
export const STORAGE_READ_CAPABILITY_PATH_PREFIX = "/_storage/read/";

/** The fully validated authorization facts carried by a signed capability. */
export interface StorageReadCapabilityClaims {
  version: typeof CLAIMS_VERSION;
  purpose: typeof PURPOSE;
  host: string;
  method: typeof CAPABILITY_METHOD;
  scopedKey: string;
  issuedAt: number;
  expiresAt: number;
}

interface WireClaims {
  v: typeof CLAIMS_VERSION;
  p: typeof PURPOSE;
  h: string;
  m: typeof CAPABILITY_METHOD;
  k: string;
  iat: number;
  exp: number;
}

export type StorageReadCapabilityFailureReason =
  | "invalid_url"
  | "method_not_allowed"
  | "malformed_token"
  | "invalid_signature"
  | "invalid_claims"
  | "host_mismatch"
  | "not_yet_valid"
  | "expired";

export type StorageReadCapabilityVerification =
  | { ok: true; claims: StorageReadCapabilityClaims }
  | { ok: false; reason: StorageReadCapabilityFailureReason };

export type StorageReadCapabilityConfigurationErrorCode =
  | "missing_secrets"
  | "invalid_secrets"
  | "secret_too_short"
  | "invalid_host"
  | "invalid_scoped_key"
  | "invalid_time_window"
  | "invalid_clock";

/**
 * Safe operational error for trusted signer/verifier configuration. Messages
 * never contain a secret, token, host, or object key.
 */
export class StorageReadCapabilityConfigurationError extends Error {
  readonly code: StorageReadCapabilityConfigurationErrorCode;

  constructor(
    code: StorageReadCapabilityConfigurationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StorageReadCapabilityConfigurationError";
    this.code = code;
  }
}

export interface MintStorageReadCapabilityUrlInput {
  rawSecrets: string | undefined;
  host: string;
  scopedKey: string;
  /** Integer Unix timestamp in seconds. */
  issuedAt: number;
  /** Integer Unix timestamp in seconds, 60 through 3600 seconds after issuedAt. */
  expiresAt: number;
}

export interface VerifyStorageReadCapabilityInput {
  rawSecrets: string | undefined;
  /** Parsed URL from the incoming Request. */
  url: URL;
  method: string;
  /** Integer Unix timestamp in seconds. */
  now: number;
}

/**
 * Mint a complete HTTPS URL whose first configured secret supplies the HMAC.
 * All signer inputs are trusted server values; invalid configuration fails
 * closed with a safe, typed error.
 */
export async function mintStorageReadCapabilityUrl({
  rawSecrets,
  host,
  scopedKey,
  issuedAt,
  expiresAt,
}: MintStorageReadCapabilityUrlInput): Promise<string> {
  const [signingSecret] = parseSecrets(rawSecrets);
  const normalizedHost = normalizeStorageReadCapabilityHost(host);
  assertScopedKey(scopedKey);
  assertTimeWindow(issuedAt, expiresAt);

  const wireClaims: WireClaims = {
    v: CLAIMS_VERSION,
    p: PURPOSE,
    h: normalizedHost,
    m: CAPABILITY_METHOD,
    k: scopedKey,
    iat: issuedAt,
    exp: expiresAt,
  };
  const payload = encodeBase64Url(
    UTF8_ENCODER.encode(JSON.stringify(wireClaims)),
  );
  const signingKey = await importHmacKey(signingSecret, "sign");
  const signature = await crypto.subtle.sign(
    "HMAC",
    signingKey,
    UTF8_ENCODER.encode(`${TOKEN_VERSION}.${payload}`),
  );
  const token = `${TOKEN_VERSION}.${payload}.${encodeBase64Url(
    new Uint8Array(signature),
  )}`;

  if (token.length > MAX_TOKEN_LENGTH) {
    throw new StorageReadCapabilityConfigurationError(
      "invalid_scoped_key",
      "The storage read object key is too large to sign safely.",
    );
  }

  return `https://${normalizedHost}${STORAGE_READ_CAPABILITY_PATH_PREFIX}${token}`;
}

/**
 * Verify an incoming GET/HEAD request without throwing for attacker-controlled
 * URL, method, token, claims, signature, or time-window contents. Invalid
 * secret configuration remains an operational error and fails separately.
 */
export async function verifyStorageReadCapability({
  rawSecrets,
  url,
  method,
  now,
}: VerifyStorageReadCapabilityInput): Promise<StorageReadCapabilityVerification> {
  const secrets = parseSecrets(rawSecrets);
  if (!isUnixSecond(now)) {
    throw new StorageReadCapabilityConfigurationError(
      "invalid_clock",
      "The storage read verification clock is invalid.",
    );
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.host.length === 0 ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return { ok: false, reason: "invalid_url" };
  }

  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod !== "GET" && normalizedMethod !== "HEAD") {
    return { ok: false, reason: "method_not_allowed" };
  }

  if (!url.pathname.startsWith(STORAGE_READ_CAPABILITY_PATH_PREFIX)) {
    return { ok: false, reason: "malformed_token" };
  }
  const token = url.pathname.slice(STORAGE_READ_CAPABILITY_PATH_PREFIX.length);
  const tokenParts = parseToken(token);
  if (!tokenParts) {
    return { ok: false, reason: "malformed_token" };
  }

  const signingInput = UTF8_ENCODER.encode(
    `${TOKEN_VERSION}.${tokenParts.payload}`,
  );
  let signatureValid = false;
  for (const secret of secrets) {
    const verificationKey = await importHmacKey(secret, "verify");
    const verified = await crypto.subtle.verify(
      "HMAC",
      verificationKey,
      tokenParts.signature,
      signingInput,
    );
    signatureValid = verified || signatureValid;
  }
  if (!signatureValid) {
    return { ok: false, reason: "invalid_signature" };
  }

  const claims = parseClaims(tokenParts.payloadBytes);
  if (!claims) {
    return { ok: false, reason: "invalid_claims" };
  }

  if (claims.host !== url.host.toLowerCase()) {
    return { ok: false, reason: "host_mismatch" };
  }
  if (claims.issuedAt > now) {
    return { ok: false, reason: "not_yet_valid" };
  }
  if (claims.expiresAt <= now) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, claims };
}

function parseSecrets(rawSecrets: string | undefined): string[] {
  if (typeof rawSecrets !== "string" || rawSecrets.trim().length === 0) {
    throw new StorageReadCapabilityConfigurationError(
      "missing_secrets",
      "Storage read signing secrets are not configured.",
    );
  }
  if (UTF8_ENCODER.encode(rawSecrets).byteLength > MAX_RAW_SECRETS_BYTES) {
    throw new StorageReadCapabilityConfigurationError(
      "invalid_secrets",
      "Storage read signing secret configuration is invalid.",
    );
  }

  const secrets = rawSecrets.split(",").map((secret) => secret.trim());
  if (
    secrets.length === 0 ||
    secrets.length > MAX_SECRET_COUNT ||
    secrets.some((secret) => secret.length === 0)
  ) {
    throw new StorageReadCapabilityConfigurationError(
      "invalid_secrets",
      "Storage read signing secret configuration is invalid.",
    );
  }

  for (const secret of secrets) {
    const secretBytes = UTF8_ENCODER.encode(secret).byteLength;
    if (secretBytes < MIN_SECRET_BYTES) {
      throw new StorageReadCapabilityConfigurationError(
        "secret_too_short",
        "Every storage read signing secret must be at least 32 UTF-8 bytes.",
      );
    }
    if (secretBytes > MAX_SECRET_BYTES) {
      throw new StorageReadCapabilityConfigurationError(
        "invalid_secrets",
        "Storage read signing secret configuration is invalid.",
      );
    }
  }

  return secrets;
}

/**
 * Canonicalize a configured HTTPS host exactly as the signer and verifier do.
 * Route and transport boundaries must use this helper rather than duplicating
 * trim, default-port, case, or IDNA handling.
 */
export function normalizeStorageReadCapabilityHost(host: string): string {
  const normalized = tryNormalizeHost(host);
  if (!normalized) {
    throw new StorageReadCapabilityConfigurationError(
      "invalid_host",
      "The storage read host configuration is invalid.",
    );
  }
  return normalized;
}

function tryNormalizeHost(host: unknown): string | null {
  if (typeof host !== "string") return null;
  const candidate = host.trim();
  if (candidate.length === 0 || candidate.length > MAX_HOST_LENGTH + 8) {
    return null;
  }

  try {
    const url = new URL(`https://${candidate}`);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.hostname.length === 0 ||
      url.hostname.length > MAX_HOST_LENGTH
    ) {
      return null;
    }
    return url.host.toLowerCase();
  } catch {
    // error-policy:J3 an invalid configured host becomes a safe typed failure.
    return null;
  }
}

function assertScopedKey(scopedKey: string): void {
  if (!isScopedKey(scopedKey)) {
    throw new StorageReadCapabilityConfigurationError(
      "invalid_scoped_key",
      "The storage read object key is not tenant scoped.",
    );
  }
}

function isScopedKey(scopedKey: unknown): scopedKey is string {
  if (
    typeof scopedKey !== "string" ||
    UTF8_ENCODER.encode(scopedKey).byteLength > MAX_SCOPED_KEY_BYTES ||
    containsControlCharacter(scopedKey)
  ) {
    return false;
  }
  const segments = scopedKey.split("/");
  return (
    segments.length >= 3 &&
    segments[0] === "org" &&
    segments.every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    )
  );
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function assertTimeWindow(issuedAt: number, expiresAt: number): void {
  if (!isValidTimeWindow(issuedAt, expiresAt)) {
    throw new StorageReadCapabilityConfigurationError(
      "invalid_time_window",
      "The storage read capability time window must be 60 through 3600 seconds.",
    );
  }
}

function isUnixSecond(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidTimeWindow(issuedAt: unknown, expiresAt: unknown): boolean {
  if (!isUnixSecond(issuedAt) || !isUnixSecond(expiresAt)) return false;
  const ttl = expiresAt - issuedAt;
  return ttl >= MIN_TTL_SECONDS && ttl <= MAX_TTL_SECONDS;
}

function parseToken(token: string): {
  payload: string;
  payloadBytes: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
} | null {
  if (
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH ||
    token.includes("/")
  ) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  const [, payload, encodedSignature] = parts;
  if (
    payload.length === 0 ||
    payload.length > MAX_PAYLOAD_LENGTH ||
    encodedSignature.length !== 43
  ) {
    return null;
  }

  const payloadBytes = decodeBase64Url(payload);
  const signature = decodeBase64Url(encodedSignature);
  if (
    !payloadBytes ||
    !signature ||
    signature.byteLength !== HMAC_SIGNATURE_BYTES
  ) {
    return null;
  }
  return { payload, payloadBytes, signature };
}

function parseClaims(
  payloadBytes: Uint8Array,
): StorageReadCapabilityClaims | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8_DECODER.decode(payloadBytes));
  } catch {
    // error-policy:J3 signed-but-malformed payloads remain invalid capabilities.
    return null;
  }
  if (!isRecord(parsed)) return null;
  const expectedKeys = ["v", "p", "h", "m", "k", "iat", "exp"];
  const actualKeys = Object.keys(parsed);
  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(parsed, key)) ||
    parsed.v !== CLAIMS_VERSION ||
    parsed.p !== PURPOSE ||
    parsed.m !== CAPABILITY_METHOD ||
    typeof parsed.h !== "string" ||
    parsed.h !== tryNormalizeHost(parsed.h) ||
    !isScopedKey(parsed.k) ||
    typeof parsed.iat !== "number" ||
    typeof parsed.exp !== "number" ||
    !isValidTimeWindow(parsed.iat, parsed.exp)
  ) {
    return null;
  }

  return {
    version: CLAIMS_VERSION,
    purpose: PURPOSE,
    host: parsed.h,
    method: CAPABILITY_METHOD,
    scopedKey: parsed.k,
    issuedAt: parsed.iat,
    expiresAt: parsed.exp,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function importHmacKey(
  secret: string,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    UTF8_ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(encoded: string): Uint8Array<ArrayBuffer> | null {
  if (
    encoded.length === 0 ||
    encoded.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/u.test(encoded)
  ) {
    return null;
  }
  const padded = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const paddingLength = (4 - (padded.length % 4)) % 4;
  try {
    const binary = atob(`${padded}${"=".repeat(paddingLength)}`);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return encodeBase64Url(bytes) === encoded ? bytes : null;
  } catch {
    // error-policy:J3 malformed base64url remains an invalid capability.
    return null;
  }
}
