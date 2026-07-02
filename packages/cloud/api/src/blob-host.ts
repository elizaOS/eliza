/**
 * Public R2 object serving for the blob host (`blob.elizacloud.ai` /
 * `R2_PUBLIC_HOST`).
 *
 * Every public URL the cloud mints for an R2 object points at this host
 * (`publicUrlForR2Key`, `uploadToBlob` — avatars, image/music generations,
 * voice-clone samples, document previews). The host was meant to serve the
 * bucket directly, but the wildcard `*.elizacloud.ai/*` Worker route shadows
 * it — same disease the feed host has (see FEED_ALIAS_HOST) — so every such
 * URL 404'd on this worker's JSON router, and anything that CONSUMES those
 * URLs broke with it: OpenAI's moderation-by-URL cannot download generated
 * images, so image generation fails closed with
 * "Content safety moderation is unavailable" on every env.
 *
 * This handler makes the worker itself serve the bucket for that host:
 * GET/HEAD → `env.BLOB`. Whole-bucket public reads match the documented
 * design ("R2 objects are public via the bucket's public host" — blob.ts);
 * writes stay API-only.
 */

import type { AppEnv } from "@/types/cloud-worker-env";

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

  const key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!key) return notFound();

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

function objectHeaders(object: BlobObjectLike): Headers {
  const headers = new Headers();
  headers.set(
    "content-type",
    object.httpMetadata?.contentType || "application/octet-stream",
  );
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
  return headers;
}
