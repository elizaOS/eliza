/**
 * Mints and verifies opaque Workers-native storage read capabilities. Tokens
 * expose only a random receipt capability id and bounded validity window;
 * object identifiers are resolved from the durable server authority.
 */
const TOKEN_VERSION = "v2";
const CLAIMS_VERSION = 2 as const;
const PURPOSE = "storage-read" as const;
const MIN_SECRET_BYTES = 32;
const MAX_TOKEN_LENGTH = 1024;
const MAX_TTL_SECONDS = 3600;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTF8 = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });

export const STORAGE_READ_CAPABILITY_PATH_PREFIX = "/_storage/c/";

export interface StorageReadCapabilityClaims {
  version: typeof CLAIMS_VERSION;
  purpose: typeof PURPOSE;
  host: string;
  capabilityId: string;
  issuedAt: number;
  expiresAt: number;
}

export class StorageReadCapabilityConfigurationError extends Error {
  constructor(
    public readonly code:
      | "missing_secrets"
      | "invalid_secrets"
      | "invalid_host"
      | "invalid_claims",
  ) {
    super(`Storage read capability configuration is invalid: ${code}`);
    this.name = "StorageReadCapabilityConfigurationError";
  }
}

function secrets(raw: string | undefined): string[] {
  if (!raw?.trim())
    throw new StorageReadCapabilityConfigurationError("missing_secrets");
  const values = raw.split(",").map((value) => value.trim());
  if (
    values.length === 0 ||
    values.length > 8 ||
    values.some(
      (value) =>
        UTF8.encode(value).byteLength < MIN_SECRET_BYTES ||
        UTF8.encode(value).byteLength > 1024,
    )
  ) {
    throw new StorageReadCapabilityConfigurationError("invalid_secrets");
  }
  return values;
}

export function normalizeStorageReadCapabilityHost(value: string): string {
  try {
    const candidate = value.trim();
    const url = new URL(`https://${candidate}`);
    if (
      !candidate ||
      candidate.length > 261 ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.hostname.length > 253
    ) {
      throw new Error("shape");
    }
    return url.host.toLowerCase();
  } catch {
    // error-policy:J3 configuration parsing produces one explicit invalid-host failure.
    throw new StorageReadCapabilityConfigurationError("invalid_host");
  }
}

export function validateStorageReadCapabilityConfiguration(
  rawSecrets: string | undefined,
  host: string,
): string {
  const normalizedHost = normalizeStorageReadCapabilityHost(host);
  secrets(rawSecrets);
  return normalizedHost;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!value || value.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/u.test(value))
    return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(
      `${standard}${"=".repeat((4 - (standard.length % 4)) % 4)}`,
    );
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index++)
      bytes[index] = binary.charCodeAt(index);
    return base64Url(bytes) === value ? bytes : null;
  } catch {
    // error-policy:J3 non-canonical bearer encodings are rejected as invalid tokens.
    return null;
  }
}

async function hmacKey(
  secret: string,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    UTF8.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function claimsPayload(claims: StorageReadCapabilityClaims): string {
  if (
    claims.version !== CLAIMS_VERSION ||
    claims.purpose !== PURPOSE ||
    !UUID.test(claims.capabilityId) ||
    !Number.isSafeInteger(claims.issuedAt) ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.issuedAt < 0 ||
    claims.expiresAt - claims.issuedAt < 60 ||
    claims.expiresAt - claims.issuedAt > MAX_TTL_SECONDS ||
    normalizeStorageReadCapabilityHost(claims.host) !== claims.host
  ) {
    throw new StorageReadCapabilityConfigurationError("invalid_claims");
  }
  return base64Url(
    UTF8.encode(
      JSON.stringify([
        claims.version,
        claims.purpose,
        claims.host,
        claims.capabilityId,
        claims.issuedAt,
        claims.expiresAt,
      ]),
    ),
  );
}

export async function mintStorageReadCapabilityUrl(input: {
  rawSecrets: string | undefined;
  host: string;
  capabilityId: string;
  issuedAt: number;
  expiresAt: number;
}): Promise<string> {
  const host = normalizeStorageReadCapabilityHost(input.host);
  const payload = claimsPayload({
    version: CLAIMS_VERSION,
    purpose: PURPOSE,
    host,
    capabilityId: input.capabilityId,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  });
  const [secret] = secrets(input.rawSecrets);
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret!, "sign"),
    UTF8.encode(`${TOKEN_VERSION}.${payload}`),
  );
  const token = `${TOKEN_VERSION}.${payload}.${base64Url(new Uint8Array(signature))}`;
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new StorageReadCapabilityConfigurationError("invalid_claims");
  }
  return `https://${host}${STORAGE_READ_CAPABILITY_PATH_PREFIX}${token}`;
}

function parseClaims(payload: Uint8Array): StorageReadCapabilityClaims | null {
  try {
    const value: unknown = JSON.parse(DECODER.decode(payload));
    if (!Array.isArray(value) || value.length !== 6) return null;
    const [version, purpose, host, capabilityId, issuedAt, expiresAt] = value;
    if (
      version !== CLAIMS_VERSION ||
      purpose !== PURPOSE ||
      typeof host !== "string" ||
      normalizeStorageReadCapabilityHost(host) !== host ||
      typeof capabilityId !== "string" ||
      !UUID.test(capabilityId) ||
      typeof issuedAt !== "number" ||
      typeof expiresAt !== "number"
    ) {
      return null;
    }
    const claims = {
      version,
      purpose,
      host,
      capabilityId,
      issuedAt,
      expiresAt,
    };
    claimsPayload(claims);
    return claims;
  } catch {
    // error-policy:J3 malformed claims are rejected without a partial authority.
    return null;
  }
}

export async function verifyStorageReadCapability(input: {
  rawSecrets: string | undefined;
  url: URL;
  method: string;
  now: number;
}): Promise<{ ok: true; claims: StorageReadCapabilityClaims } | { ok: false }> {
  const configuredSecrets = secrets(input.rawSecrets);
  if (
    (input.method !== "GET" && input.method !== "HEAD") ||
    input.url.protocol !== "https:" ||
    input.url.search ||
    input.url.hash ||
    !input.url.pathname.startsWith(STORAGE_READ_CAPABILITY_PATH_PREFIX)
  ) {
    return { ok: false };
  }
  const token = input.url.pathname.slice(
    STORAGE_READ_CAPABILITY_PATH_PREFIX.length,
  );
  if (!token || token.length > MAX_TOKEN_LENGTH || token.includes("/"))
    return { ok: false };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return { ok: false };
  const payload = decodeBase64Url(parts[1]!);
  const signature = decodeBase64Url(parts[2]!);
  if (!payload || !signature || signature.byteLength !== 32)
    return { ok: false };
  let valid = false;
  for (const secret of configuredSecrets) {
    valid =
      (await crypto.subtle.verify(
        "HMAC",
        await hmacKey(secret, "verify"),
        signature,
        UTF8.encode(`${TOKEN_VERSION}.${parts[1]}`),
      )) || valid;
  }
  if (!valid) return { ok: false };
  const claims = parseClaims(payload);
  if (
    !claims ||
    claims.host !== input.url.host.toLowerCase() ||
    !Number.isSafeInteger(input.now) ||
    claims.issuedAt > input.now ||
    claims.expiresAt <= input.now
  ) {
    return { ok: false };
  }
  return { ok: true, claims };
}
