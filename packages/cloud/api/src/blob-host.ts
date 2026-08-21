/**
 * Serves public R2 objects and opaque capability-authorized private storage
 * generations. Private URLs never contain logical or provider object keys;
 * the durable receipt is resolved before exact-generation native access.
 */
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  normalizeStorageReadCapabilityHost,
  STORAGE_READ_CAPABILITY_PATH_PREFIX,
  StorageReadCapabilityConfigurationError,
  verifyStorageReadCapability,
} from "./storage-read-capability";

export const PUBLIC_BLOB_PREFIXES: readonly string[] = [
  "avatars/",
  "generations/",
  "voice-samples/",
  "promotion-assets/",
  "cloud-files/",
  "affiliate/",
  "cloud-avatars/",
  "cloud-agent-samples/",
];

export function isStorageReadCapabilityPath(url: URL): boolean {
  return url.pathname.startsWith(STORAGE_READ_CAPABILITY_PATH_PREFIX);
}

function isPublicBlobKey(key: string): boolean {
  return PUBLIC_BLOB_PREFIXES.some((prefix) => key.startsWith(prefix));
}

type BlobHostBindings = Pick<
  AppEnv["Bindings"],
  "BLOB" | "R2_PUBLIC_HOST" | "STORAGE_READ_SIGNING_SECRETS"
>;

const DEFAULT_BLOB_HOST = "blob.eliza.app";

interface BlobObjectLike {
  body?: ReadableStream | null;
  size?: number;
  etag?: string;
  httpEtag?: string;
  httpMetadata?: {
    contentType?: string;
    contentLanguage?: string;
    contentEncoding?: string;
  };
  writeHttpMetadata?(headers: Headers): void;
  arrayBuffer?(): Promise<ArrayBuffer>;
  text?(): Promise<string>;
}

interface BlobBucketLike {
  get(
    key: string,
    options?: {
      range?: { offset: number; length: number };
      onlyIf?: { etagMatches: string };
    },
  ): Promise<BlobObjectLike | null>;
  head?(key: string): Promise<BlobObjectLike | null>;
}

type ParsedRange =
  | { kind: "bounded"; start: number; end: number }
  | { kind: "open"; start: number }
  | { kind: "suffix"; length: number };

function configuredBlobHost(env: BlobHostBindings): string {
  const host = env.R2_PUBLIC_HOST;
  return typeof host === "string" && host.trim()
    ? host.trim().toLowerCase()
    : DEFAULT_BLOB_HOST;
}

function privateHeaders(): Headers {
  return new Headers({
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
  });
}

function notFound(isPrivate = false): Response {
  return Response.json(
    { success: false, error: "Not found", code: "resource_not_found" },
    { status: 404, ...(isPrivate ? { headers: privateHeaders() } : {}) },
  );
}

function unavailable(): Response {
  return Response.json(
    {
      success: false,
      error: "Storage temporarily unavailable",
      code: "storage_unavailable",
    },
    { status: 503, headers: privateHeaders() },
  );
}

function withoutHeadBody(response: Response, method: string): Response {
  if (method !== "HEAD" || response.body === null) return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function parseNumber(value: string): number | undefined {
  if (!/^\d{1,16}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseRange(value: string): ParsedRange | undefined {
  if (value.length > 64 || value.includes(",")) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  if (!match[1]) {
    const length = parseNumber(match[2]!);
    return length && length > 0 ? { kind: "suffix", length } : undefined;
  }
  const start = parseNumber(match[1]);
  if (start === undefined) return undefined;
  if (!match[2]) return { kind: "open", start };
  const end = parseNumber(match[2]);
  return end !== undefined && end >= start
    ? { kind: "bounded", start, end }
    : undefined;
}

function resolveRange(
  range: ParsedRange,
  size: number,
): { offset: number; length: number; end: number } | undefined {
  if (size <= 0) return undefined;
  if (range.kind === "suffix") {
    const length = Math.min(range.length, size);
    return { offset: size - length, length, end: size - 1 };
  }
  if (range.start >= size) return undefined;
  const end =
    range.kind === "bounded" ? Math.min(range.end, size - 1) : size - 1;
  return { offset: range.start, length: end - range.start + 1, end };
}

function rangeFailure(size?: number): Response {
  const headers = privateHeaders();
  headers.set("accept-ranges", "bytes");
  if (size !== undefined) headers.set("content-range", `bytes */${size}`);
  return Response.json(
    {
      success: false,
      error: "Range not satisfiable",
      code: "range_not_satisfiable",
    },
    { status: 416, headers },
  );
}

async function authorizeCapability(
  env: BlobHostBindings,
  capabilityId: string,
  capabilityHost: string,
  now: Date,
) {
  const [{ runWithCloudBindingsAsync }, { runWithDbCacheAsync }, authority] =
    await Promise.all([
      import("@/lib/runtime/cloud-bindings"),
      import("@/db/client"),
      import("@/lib/services/storage/native-storage-read"),
    ]);
  return await runWithCloudBindingsAsync(env, () =>
    runWithDbCacheAsync(() =>
      authority.authorizeNativeStorageCapability({
        capabilityId,
        capabilityHost,
        now,
      }),
    ),
  );
}

export async function serveBlobHostRequest(
  request: Request,
  url: URL,
  env: BlobHostBindings,
): Promise<Response | null> {
  const capabilityPath = isStorageReadCapabilityPath(url);
  const configuredHost = configuredBlobHost(env);
  if (url.host.toLowerCase() !== configuredHost) {
    return capabilityPath
      ? withoutHeadBody(notFound(true), request.method)
      : null;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    const headers = capabilityPath ? privateHeaders() : new Headers();
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

  if (capabilityPath) {
    try {
      return await servePrivateCapability(request, url, env);
    } catch (error) {
      // error-policy:J1 capability configuration, database, and native R2
      // failures are translated without serializing bearer or object details.
      if (error instanceof StorageReadCapabilityConfigurationError) {
        return withoutHeadBody(unavailable(), request.method);
      }
      return withoutHeadBody(unavailable(), request.method);
    }
  }

  let key: string;
  try {
    key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    // error-policy:J3 malformed URL encoding is an explicit not-found result.
    return notFound();
  }
  if (!key || !isPublicBlobKey(key)) return notFound();
  return await servePublicObject(
    request.method,
    key,
    env.BLOB as BlobBucketLike,
  );
}

async function servePrivateCapability(
  request: Request,
  url: URL,
  env: BlobHostBindings,
): Promise<Response> {
  if (!env.R2_PUBLIC_HOST?.trim())
    return withoutHeadBody(unavailable(), request.method);
  const explicitHost = normalizeStorageReadCapabilityHost(env.R2_PUBLIC_HOST);
  if (url.host.toLowerCase() !== explicitHost)
    return withoutHeadBody(notFound(true), request.method);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const verified = await verifyStorageReadCapability({
    rawSecrets: env.STORAGE_READ_SIGNING_SECRETS,
    url,
    method: request.method,
    now: nowSeconds,
  });
  if (!verified.ok) return withoutHeadBody(notFound(true), request.method);
  const authority = await authorizeCapability(
    env,
    verified.claims.capabilityId,
    verified.claims.host,
    new Date(nowSeconds * 1000),
  );
  if (
    !authority?.provider_key ||
    authority.result_size_bytes === null ||
    !authority.result_etag ||
    !authority.result_content_type ||
    !authority.capability_issued_at ||
    !authority.capability_expires_at ||
    Math.floor(authority.capability_issued_at.getTime() / 1000) !==
      verified.claims.issuedAt ||
    Math.floor(authority.capability_expires_at.getTime() / 1000) !==
      verified.claims.expiresAt
  ) {
    return withoutHeadBody(notFound(true), request.method);
  }
  const size = Number(authority.result_size_bytes);
  if (!Number.isSafeInteger(size) || size < 0)
    return withoutHeadBody(unavailable(), request.method);
  const bucket = env.BLOB as BlobBucketLike;
  if (request.method === "HEAD") {
    const object = await bucket.head?.(authority.provider_key);
    if (!exactObject(object, size, authority.result_etag)) {
      return withoutHeadBody(unavailable(), "HEAD");
    }
    return new Response(null, {
      status: 200,
      headers: privateObjectHeaders(
        object!,
        authority.result_content_type,
        size,
      ),
    });
  }

  const requestedRange = request.headers.get("range");
  if (!requestedRange) {
    const object = await bucket.get(authority.provider_key, {
      onlyIf: { etagMatches: authority.result_etag },
    });
    if (!exactObject(object, size, authority.result_etag)) return unavailable();
    return new Response(await objectBody(object!), {
      status: 200,
      headers: privateObjectHeaders(
        object!,
        authority.result_content_type,
        size,
      ),
    });
  }

  const parsed = parseRange(requestedRange);
  if (!parsed) return rangeFailure();
  const range = resolveRange(parsed, size);
  if (!range) return rangeFailure(size);
  const object = await bucket.get(authority.provider_key, {
    range: { offset: range.offset, length: range.length },
    onlyIf: { etagMatches: authority.result_etag },
  });
  if (!object?.body) return unavailable();
  if (object.etag && object.etag !== authority.result_etag)
    return unavailable();
  const headers = privateObjectHeaders(
    object,
    authority.result_content_type,
    range.length,
  );
  headers.set("content-range", `bytes ${range.offset}-${range.end}/${size}`);
  return new Response(await objectBody(object), { status: 206, headers });
}

function exactObject(
  object: BlobObjectLike | null | undefined,
  size: number,
  etag: string,
): object is BlobObjectLike {
  return Boolean(object && object.size === size && object.etag === etag);
}

async function servePublicObject(
  method: string,
  key: string,
  bucket: BlobBucketLike,
): Promise<Response> {
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
  return (
    object.body ??
    (object.arrayBuffer
      ? await object.arrayBuffer()
      : ((await object.text?.()) ?? null))
  );
}

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

function secureHeaders(headers: Headers, contentType: string): Headers {
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
  const contentType =
    object.httpMetadata?.contentType || "application/octet-stream";
  const headers = new Headers({
    "content-type": contentType,
    "cache-control": "public, max-age=3600",
    "access-control-allow-origin": "*",
  });
  if (typeof object.size === "number")
    headers.set("content-length", String(object.size));
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  return secureHeaders(headers, contentType);
}

function privateObjectHeaders(
  object: BlobObjectLike,
  contentType: string,
  contentLength: number,
): Headers {
  const headers = privateHeaders();
  object.writeHttpMetadata?.(headers);
  headers.set("content-type", contentType);
  headers.set("content-length", String(contentLength));
  headers.set("etag", object.httpEtag ?? object.etag ?? "");
  headers.set("accept-ranges", "bytes");
  headers.delete("access-control-allow-origin");
  headers.delete("expires");
  return secureHeaders(headers, contentType);
}
