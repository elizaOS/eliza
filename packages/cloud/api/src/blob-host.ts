/**
 * Public and capability-gated R2 object serving on the configured blob host.
 *
 * Public-by-URL namespaces retain their allowlisted cacheable behavior. Private
 * attachment objects are reachable only through a short-lived storage-read
 * capability whose verified claims supply the exact tenant-scoped R2 key;
 * attacker-controlled paths are never used as private object keys.
 */

import type { AppEnv } from "@/types/cloud-worker-env";
import {
  normalizeStorageReadCapabilityHost,
  STORAGE_READ_CAPABILITY_PATH_PREFIX,
  StorageReadCapabilityConfigurationError,
  verifyStorageReadCapability,
} from "./storage-read-capability";

/**
 * Deny-by-default allowlist of public-by-URL key prefixes.
 *
 * INVARIANT: a prefix belongs here only when its writer intentionally mints an
 * unauthenticated public URL on `R2_PUBLIC_HOST` for keys under it (verify the
 * writer AND the consumer before adding one). Everything else in `env.BLOB` is
 * private and requires a verified storage-read capability.
 */
export const PUBLIC_BLOB_PREFIXES: readonly string[] = [
  // User + character avatars — putPublicObject (v1/user/avatar,
  // my-agents/characters/avatar); URLs stored on records and rendered in UI.
  "avatars/",
  // Image/music generation outputs — putPublicObject (v1/generate-image,
  // apps/[id]/generate-image, v1/generate-music); URLs returned to callers and
  // fetched by OpenAI moderation-by-URL.
  "generations/",
  // Voice-clone sample uploads — v1/voice/clone mints public URLs fetched by
  // the voice provider.
  "voice-samples/",
  // App promotion imagery (social cards/banners/screenshots) —
  // app-promotion-assets service; fetched by URL for moderation + posting.
  "promotion-assets/",
  // Org-scoped cloud file uploads — cloud-files service mints unguessable
  // public-by-URL handles after auth-gated upload/list/get.
  "cloud-files/",
  // Affiliate character avatar/reference images — affiliate-images service;
  // URLs become character avatar/reference URLs.
  "affiliate/",
  // Built-in static avatar sets hardcoded in the UI (default-user-avatar.ts,
  // default-avatar.ts, eliza-avatar.tsx).
  "cloud-avatars/",
  "cloud-agent-samples/",
];

function isPublicBlobKey(key: string): boolean {
  return PUBLIC_BLOB_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** The only bindings this handler reads — narrow so tests need no casts. */
type BlobHostBindings = Pick<
  AppEnv["Bindings"],
  "BLOB" | "R2_PUBLIC_HOST" | "STORAGE_READ_SIGNING_SECRETS"
>;

const DEFAULT_BLOB_HOST = "blob.eliza.app";

interface BlobHttpMetadataLike {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

type BlobRange =
  | { offset: number; length?: number }
  | { offset?: number; length: number }
  | { suffix: number };

/** Native R2 response fields used by this transport boundary. */
interface BlobObjectLike {
  body?: ReadableStream | null;
  size?: number;
  etag?: string;
  httpEtag?: string;
  httpMetadata?: BlobHttpMetadataLike;
  range?: BlobRange;
  writeHttpMetadata?(headers: Headers): void;
  arrayBuffer?(): Promise<ArrayBuffer>;
  text?(): Promise<string>;
}

/** Native R2 binding methods used by this transport boundary. */
interface BlobBucketLike {
  get(
    key: string,
    options?: {
      range?: BlobRange;
      onlyIf?: { etagMatches: string };
    },
  ): Promise<BlobObjectLike | null>;
  head?(key: string): Promise<BlobObjectLike | null>;
}

interface ResolvedByteRange {
  offset: number;
  length: number;
  end: number;
}

type ParsedByteRange =
  | { kind: "bounded"; start: number; end: number }
  | { kind: "open"; start: number }
  | { kind: "suffix"; length: number };

type BlobHostConfiguration =
  | { kind: "default" | "explicit"; host: string }
  | { kind: "invalid" };

function blobHostConfiguration(env: BlobHostBindings): BlobHostConfiguration {
  const host = env.R2_PUBLIC_HOST;
  if (typeof host !== "string" || host.trim().length === 0) {
    return { kind: "default", host: DEFAULT_BLOB_HOST };
  }
  try {
    return {
      kind: "explicit",
      host: normalizeStorageReadCapabilityHost(host),
    };
  } catch (error) {
    // error-policy:J1 an invalid trusted host configuration removes this
    // transport surface without echoing the configured value to the response.
    if (error instanceof StorageReadCapabilityConfigurationError) {
      return { kind: "invalid" };
    }
    throw error;
  }
}

function privateResponseHeaders(): HeadersInit {
  return {
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
  };
}

function notFound(isPrivate = false): Response {
  return Response.json(
    { success: false, error: "Not found", code: "resource_not_found" },
    {
      status: 404,
      ...(isPrivate ? { headers: privateResponseHeaders() } : {}),
    },
  );
}

function storageUnavailable(): Response {
  return Response.json(
    {
      success: false,
      error: "Storage temporarily unavailable",
      code: "storage_unavailable",
    },
    { status: 503, headers: privateResponseHeaders() },
  );
}

function rangeNotSatisfiable(size?: number): Response {
  const headers = new Headers(privateResponseHeaders());
  headers.set("accept-ranges", "bytes");
  if (isNonNegativeSafeInteger(size)) {
    headers.set("content-range", `bytes */${size}`);
  }
  return Response.json(
    {
      success: false,
      error: "Range not satisfiable",
      code: "range_not_satisfiable",
    },
    { status: 416, headers },
  );
}

function methodNotAllowed(isPrivate: boolean): Response {
  const headers = new Headers(isPrivate ? privateResponseHeaders() : undefined);
  headers.set("allow", "GET, HEAD");
  return Response.json(
    {
      success: false,
      error: "Method not allowed",
      code: "method_not_allowed",
    },
    { status: 405, headers },
  );
}

function withoutBodyForHead(response: Response, method: string): Response {
  if (method.toUpperCase() !== "HEAD" || response.body === null)
    return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function isNonNegativeSafeInteger(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseSafeDecimal(value: string): number | null {
  // R2 objects are far below Number.MAX_SAFE_INTEGER. Bounding the digit count
  // also makes attacker-controlled Range parsing constant-space.
  if (!/^\d{1,16}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseSingleByteRange(header: string): ParsedByteRange | null {
  if (header.length > 64 || header.includes(",")) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return null;

  const rawStart = match[1] ?? "";
  const rawEnd = match[2] ?? "";
  if (!rawStart && !rawEnd) return null;

  if (!rawStart) {
    const length = parseSafeDecimal(rawEnd);
    return length !== null && length > 0 ? { kind: "suffix", length } : null;
  }

  const start = parseSafeDecimal(rawStart);
  if (start === null) return null;
  if (!rawEnd) return { kind: "open", start };

  const end = parseSafeDecimal(rawEnd);
  return end !== null && end >= start ? { kind: "bounded", start, end } : null;
}

function resolveByteRange(
  parsed: ParsedByteRange,
  size: number,
): ResolvedByteRange | null {
  if (size === 0) return null;

  if (parsed.kind === "suffix") {
    const length = Math.min(parsed.length, size);
    const offset = size - length;
    return { offset, length, end: size - 1 };
  }

  if (parsed.start >= size) return null;
  const end =
    parsed.kind === "bounded" ? Math.min(parsed.end, size - 1) : size - 1;
  return { offset: parsed.start, length: end - parsed.start + 1, end };
}

function isCapabilityPath(url: URL): boolean {
  return url.pathname.startsWith(STORAGE_READ_CAPABILITY_PATH_PREFIX);
}

export async function serveBlobHostRequest(
  request: Request,
  url: URL,
  env: BlobHostBindings,
): Promise<Response | null> {
  const requestHost = url.host.toLowerCase();
  const capabilityPath = isCapabilityPath(url);
  const hostConfiguration = blobHostConfiguration(env);
  if (hostConfiguration.kind === "invalid") {
    return capabilityPath
      ? withoutBodyForHead(storageUnavailable(), request.method)
      : null;
  }
  if (requestHost !== hostConfiguration.host) {
    // A capability is a bearer credential in the URL path. Reserve its
    // namespace on every host so later redirects/proxies cannot forward it.
    return capabilityPath
      ? withoutBodyForHead(notFound(true), request.method)
      : null;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed(capabilityPath);
  }

  // Private capabilities deliberately require an explicit per-environment
  // host. The legacy default remains only for existing public blob URLs.
  if (capabilityPath) {
    if (hostConfiguration.kind !== "explicit") {
      return withoutBodyForHead(notFound(true), request.method);
    }
    try {
      return await serveCapabilityRequest(request, url, env);
    } catch {
      // error-policy:J4 Web Crypto and native R2 failures are transient private
      // transport failures. Never leak the bearer, object key, or provider error.
      return withoutBodyForHead(storageUnavailable(), request.method);
    }
  }

  let key: string;
  try {
    key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    // error-policy:J3 malformed URL encoding is untrusted input and maps to an
    // explicit not-found result rather than a fabricated key.
    return notFound();
  }
  if (!key || !isPublicBlobKey(key)) return notFound();

  return servePublicObject(request.method, key, env.BLOB);
}

async function serveCapabilityRequest(
  request: Request,
  url: URL,
  env: BlobHostBindings,
): Promise<Response> {
  let verification: Awaited<ReturnType<typeof verifyStorageReadCapability>>;
  try {
    verification = await verifyStorageReadCapability({
      rawSecrets: env.STORAGE_READ_SIGNING_SECRETS,
      url,
      method: request.method,
      now: Math.floor(Date.now() / 1_000),
    });
  } catch (error) {
    // error-policy:J1 configuration errors are translated at the HTTP boundary
    // without exposing the secret, token, or verified private key.
    if (error instanceof StorageReadCapabilityConfigurationError) {
      return withoutBodyForHead(storageUnavailable(), request.method);
    }
    throw error;
  }

  if (!verification.ok) {
    return withoutBodyForHead(notFound(true), request.method);
  }

  const bucket: BlobBucketLike = env.BLOB;
  const key = verification.claims.scopedKey;

  if (request.method === "HEAD") {
    // The native binding always exposes head(). Refuse to fall back to get()
    // here because a HEAD request must not read the private object body.
    if (!bucket.head) return withoutBodyForHead(storageUnavailable(), "HEAD");
    const object = await bucket.head(key);
    if (!object) return withoutBodyForHead(notFound(true), "HEAD");
    return new Response(null, {
      status: 200,
      headers: privateObjectHeaders(object),
    });
  }

  const rangeHeader = request.headers.get("range");
  if (rangeHeader === null) {
    const object = await bucket.get(key);
    if (!object) return notFound(true);
    return new Response(await objectBody(object), {
      status: 200,
      headers: privateObjectHeaders(object),
    });
  }

  const parsedRange = parseSingleByteRange(rangeHeader);
  if (!parsedRange) return rangeNotSatisfiable();
  if (!bucket.head) return storageUnavailable();

  const metadata = await bucket.head(key);
  if (!metadata) return notFound(true);
  if (
    !isNonNegativeSafeInteger(metadata.size) ||
    typeof metadata.etag !== "string" ||
    metadata.etag.length === 0
  ) {
    return storageUnavailable();
  }

  const range = resolveByteRange(parsedRange, metadata.size);
  if (!range) return rangeNotSatisfiable(metadata.size);

  const object = await bucket.get(key, {
    range: { offset: range.offset, length: range.length },
    onlyIf: { etagMatches: metadata.etag },
  });
  if (!object) return notFound(true);
  // A failed R2 precondition returns metadata without a body. Do not combine
  // stale HEAD range facts with bytes from a concurrently replaced object.
  if (!object.body) return storageUnavailable();

  const headers = privateObjectHeaders(object, range.length);
  headers.set(
    "content-range",
    `bytes ${range.offset}-${range.end}/${metadata.size}`,
  );
  return new Response(await objectBody(object), {
    status: 206,
    headers,
  });
}

async function servePublicObject(
  method: string,
  key: string,
  binding: BlobHostBindings["BLOB"],
): Promise<Response> {
  const bucket: BlobBucketLike = binding;
  if (method === "HEAD") {
    const object = bucket.head ? await bucket.head(key) : await bucket.get(key);
    if (!object) return notFound();
    return new Response(null, {
      status: 200,
      headers: publicObjectHeaders(object),
    });
  }

  const object = await bucket.get(key);
  if (!object) return notFound();
  return new Response(await objectBody(object), {
    status: 200,
    headers: publicObjectHeaders(object),
  });
}

async function objectBody(object: BlobObjectLike): Promise<BodyInit | null> {
  if (object.body) return object.body;
  if (object.arrayBuffer) return object.arrayBuffer();
  return (await object.text?.()) ?? null;
}

/**
 * MIME types safe to render inline on this origin. Everything else — notably
 * `image/svg+xml`, HTML/XML, and unknown/active types — is forced to download
 * so it can never execute script here.
 */
function isInlineSafeContentType(contentType: string): boolean {
  const mime = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (mime === "image/svg+xml") return false;
  return (
    mime.startsWith("image/") ||
    mime.startsWith("audio/") ||
    mime.startsWith("video/") ||
    mime === "application/pdf"
  );
}

function metadataHeaders(object: BlobObjectLike): Headers {
  const headers = new Headers();
  if (object.writeHttpMetadata) {
    object.writeHttpMetadata(headers);
  } else {
    const metadata = object.httpMetadata;
    if (metadata?.contentType) {
      headers.set("content-type", metadata.contentType);
    }
    if (metadata?.contentLanguage) {
      headers.set("content-language", metadata.contentLanguage);
    }
    if (metadata?.contentEncoding) {
      headers.set("content-encoding", metadata.contentEncoding);
    }
  }

  if (!headers.has("content-type")) {
    headers.set("content-type", "application/octet-stream");
  }
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  return headers;
}

function secureObjectHeaders(headers: Headers): Headers {
  const contentType = headers.get("content-type") ?? "application/octet-stream";
  headers.set("x-content-type-options", "nosniff");
  headers.set(
    "content-disposition",
    isInlineSafeContentType(contentType) ? "inline" : "attachment",
  );
  headers.set(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  );
  return headers;
}

function publicObjectHeaders(object: BlobObjectLike): Headers {
  // Keep the established public-by-URL header contract independent from the
  // richer private attachment metadata path.
  const headers = new Headers();
  headers.set(
    "content-type",
    object.httpMetadata?.contentType ?? "application/octet-stream",
  );
  if (isNonNegativeSafeInteger(object.size)) {
    headers.set("content-length", String(object.size));
  }
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  // Preserve the existing public-by-URL policy.
  headers.set("cache-control", "public, max-age=3600");
  headers.set("access-control-allow-origin", "*");
  return secureObjectHeaders(headers);
}

function privateObjectHeaders(
  object: BlobObjectLike,
  responseLength?: number,
): Headers {
  const headers = metadataHeaders(object);
  const contentLength = responseLength ?? object.size;
  if (isNonNegativeSafeInteger(contentLength)) {
    headers.set("content-length", String(contentLength));
  }
  headers.set("cache-control", "private, no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.delete("expires");
  headers.delete("access-control-allow-origin");
  headers.set("accept-ranges", "bytes");
  return secureObjectHeaders(headers);
}
