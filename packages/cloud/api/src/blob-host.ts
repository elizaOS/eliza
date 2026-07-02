/**
 * Public R2 object serving for the blob host (`blob.elizacloud.ai` /
 * `R2_PUBLIC_HOST`).
 *
 * Every public URL the cloud mints for an R2 object points at this host
 * (`publicUrlForR2Key`, `uploadToBlob` — avatars, image/music generations,
 * voice-clone samples). The host was meant to serve the
 * bucket directly, but the wildcard `*.elizacloud.ai/*` Worker route shadows
 * it — same disease the feed host has (see FEED_ALIAS_HOST) — so every such
 * URL 404'd on this worker's JSON router, and anything that CONSUMES those
 * URLs broke with it: OpenAI's moderation-by-URL cannot download generated
 * images, so image generation fails closed with
 * "Content safety moderation is unavailable" on every env.
 *
 * This handler makes the worker itself serve the bucket for that host:
 * GET/HEAD → `env.BLOB` — but ONLY for keys under a public-by-URL prefix
 * (`PUBLIC_BLOB_PREFIXES`). The same bucket also stores private heavy-payload
 * offloads (`object-namespace.ts`: conversation message bodies, phone/Twilio
 * payloads, sandbox backups, deploy logs, …) that must never be reachable
 * unauthenticated. Writes stay API-only.
 */

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Deny-by-default allowlist of public-by-URL key prefixes.
 *
 * INVARIANT: a prefix belongs here only when its writer intentionally mints an
 * unauthenticated public URL on `R2_PUBLIC_HOST` for keys under it (verify the
 * writer AND the consumer before adding one). Everything else in `env.BLOB` is
 * private — the bucket doubles as the heavy-payload offload store
 * (`@/lib/storage/object-namespace`) — and must return the JSON 404.
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
type BlobHostBindings = Pick<AppEnv["Bindings"], "BLOB" | "R2_PUBLIC_HOST">;

const DEFAULT_BLOB_HOST = "blob.elizacloud.ai";

/**
 * The slice of the native Workers R2 API this handler reads. The shared
 * `RuntimeR2Bucket` type is deliberately narrow (put/get/delete for route
 * code); the real binding also exposes `head`, streaming `body`, `size` and
 * `httpEtag`. Everything here is optional so the shared type stays assignable
 * and the handler degrades per capability (test shims included).
 */
interface BlobObjectLike {
  body?: ReadableStream | null;
  size?: number;
  httpEtag?: string;
  httpMetadata?: { contentType?: string };
  arrayBuffer?(): Promise<ArrayBuffer>;
  text?(): Promise<string>;
}

interface BlobBucketLike {
  get(key: string): Promise<BlobObjectLike | null>;
  head?(key: string): Promise<BlobObjectLike | null>;
}

function configuredBlobHost(env: BlobHostBindings): string {
  const host = env.R2_PUBLIC_HOST;
  return typeof host === "string" && host.trim().length > 0
    ? host.trim().toLowerCase()
    : DEFAULT_BLOB_HOST;
}

function notFound(): Response {
  return Response.json(
    { success: false, error: "Not found", code: "resource_not_found" },
    { status: 404 },
  );
}

export async function serveBlobHostRequest(
  request: Request,
  url: URL,
  env: BlobHostBindings,
): Promise<Response | null> {
  if (url.hostname.toLowerCase() !== configuredBlobHost(env)) return null;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json(
      {
        success: false,
        error: "Method not allowed",
        code: "method_not_allowed",
      },
      { status: 405, headers: { allow: "GET, HEAD" } },
    );
  }

  let key: string;
  try {
    key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    // Malformed percent-encoding (e.g. `%E0%A4%A`) — treat as a bad key, not
    // a worker error.
    return notFound();
  }
  if (!key || !isPublicBlobKey(key)) return notFound();

  const bucket: BlobBucketLike = env.BLOB;

  if (request.method === "HEAD") {
    const head = bucket.head ? await bucket.head(key) : await bucket.get(key);
    if (!head) return notFound();
    return new Response(null, { status: 200, headers: objectHeaders(head) });
  }

  const object = await bucket.get(key);
  if (!object) return notFound();

  const body =
    object.body ??
    (object.arrayBuffer
      ? await object.arrayBuffer()
      : ((await object.text?.()) ?? null));
  return new Response(body, { status: 200, headers: objectHeaders(object) });
}

/**
 * MIME types safe to render inline on this origin. Everything else — notably
 * `image/svg+xml`, HTML/XML, and unknown/active types — is forced to download
 * so it can never execute script here (stored-XSS defence). Mirrors the
 * media-store convention in `packages/agent/src/api/media-store.ts` (cloud/api
 * cannot import across that boundary, so the logic lives locally).
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

function objectHeaders(object: BlobObjectLike): Headers {
  const headers = new Headers();
  const contentType =
    object.httpMetadata?.contentType || "application/octet-stream";
  headers.set("content-type", contentType);
  if (typeof object.size === "number") {
    headers.set("content-length", String(object.size));
  }
  if (object.httpEtag) {
    headers.set("etag", object.httpEtag);
  }
  // Objects are keyed by timestamp/uuid and never rewritten in place, so
  // client caching is safe; an hour keeps accidental key reuse recoverable.
  headers.set("cache-control", "public, max-age=3600");
  headers.set("access-control-allow-origin", "*");
  // Stored-XSS defence: never let a mislabelled object be sniffed to HTML, and
  // force active/unknown types (SVG, HTML/XML, octet-stream, …) to download
  // instead of rendering on this origin. The sandboxed CSP applies when the
  // URL is navigated to as a document.
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
