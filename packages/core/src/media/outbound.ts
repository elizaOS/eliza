/**
 * Resolves model-supplied outbound attachment bytes for connector delivery.
 *
 * `data:` URLs are decoded in-process. Canonical media-store handles
 * (`/api/media/<sha256>.<ext>`) use the caller's local fetch. http(s) URLs go
 * through the SSRF-guarded media fetcher. Filesystem paths, `file:` URLs, and
 * other schemes are rejected without reading the host disk. Connectors must
 * send the returned bytes and must not pass the original URL to discord.js,
 * Telegram, or `fs`.
 */

import type { PinnedLookupFetchLike } from "../network/fetch-guard.js";
import type { LookupFn } from "../network/ssrf.js";
import { DEFAULT_CONNECTOR_ATTACHMENT_MAX_BYTES } from "./attachments.ts";
import {
  type FetchLike,
  fetchRemoteMedia,
  MediaFetchError,
  readResponseWithLimit,
} from "./fetch.ts";
import { trustedLocalMediaUrl } from "./local-store.ts";
import { extensionForMime } from "./mime.ts";

/** Bytes plus metadata a connector can upload without touching the original URL. */
export interface ResolvedOutboundAttachmentBytes {
  buffer: Buffer;
  contentType: string;
  fileName?: string;
}

/** DNS, transport, and size injection for outbound attachment resolution. */
export type ResolveOutboundAttachmentOptions = {
  maxBytes?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  lookupFn?: LookupFn;
  pinnedFetchImpl?: PinnedLookupFetchLike;
  /**
   * Authenticated fetch used only for canonical media-store handles. Remote
   * http(s) URLs never use this seam; they go through the SSRF guard.
   */
  localFetch?: FetchLike;
};

const DEFAULT_OUTBOUND_TIMEOUT_MS = 30_000;

/** Host/path preview for logs; never includes a `data:` payload. */
export function summarizeOutboundAttachmentUrl(url: string): {
  scheme: string;
  host?: string;
  path?: string;
} {
  const trimmed = url.trim();
  if (trimmed.startsWith("data:")) {
    const comma = trimmed.indexOf(",");
    const header = (comma >= 0 ? trimmed.slice("data:".length, comma) : "")
      .replace(/;base64$/i, "")
      .split(";")[0]
      ?.trim();
    return { scheme: "data", path: header || "application/octet-stream" };
  }
  try {
    const parsed = new URL(trimmed);
    return {
      scheme: parsed.protocol.replace(/:$/, ""),
      host: parsed.host,
      path: parsed.pathname.split("/").slice(0, 4).join("/"),
    };
  } catch {
    return { scheme: "opaque" };
  }
}

function decodeDataUrl(
  url: string,
  maxBytes: number,
): ResolvedOutboundAttachmentBytes {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma < 0) {
    throw new MediaFetchError("fetch_failed", "malformed data URL");
  }
  const header = url.slice("data:".length, comma);
  const payload = url.slice(comma + 1);
  const isBase64 = /(?:^|;)base64$/i.test(header.trim());
  const mime =
    header
      .replace(/;base64$/i, "")
      .split(";")[0]
      ?.trim()
      .toLowerCase() || "application/octet-stream";

  let buffer: Buffer;
  try {
    if (isBase64) {
      buffer = Buffer.from(payload.replace(/\s+/g, ""), "base64");
    } else {
      buffer = Buffer.from(decodeURIComponent(payload), "utf8");
    }
  } catch (error) {
    // error-policy:J3 malformed data-URL encoding is untrusted input; never
    // include the payload in the thrown message.
    throw new MediaFetchError(
      "fetch_failed",
      "failed to decode data URL",
      error,
    );
  }
  if (buffer.length === 0) {
    throw new MediaFetchError("fetch_failed", "data URL contained no bytes");
  }
  if (buffer.length > maxBytes) {
    throw new MediaFetchError(
      "max_bytes",
      `data URL exceeds maxBytes ${maxBytes}`,
    );
  }
  const ext = extensionForMime(mime);
  return {
    buffer,
    contentType: mime,
    ...(ext ? { fileName: `attachment${ext}` } : {}),
  };
}

async function fetchLocalMediaStoreBytes(
  localUrl: URL,
  opts: ResolveOutboundAttachmentOptions,
  maxBytes: number,
  timeoutMs: number,
): Promise<ResolvedOutboundAttachmentBytes> {
  const fetcher = opts.localFetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw new MediaFetchError(
      "fetch_failed",
      "local media-store fetch is not available",
    );
  }
  let response: Response;
  try {
    response = await fetcher(localUrl.href, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // error-policy:J2 wrap the local-store transport failure without turning it
    // into a remote SSRF fetch.
    throw new MediaFetchError(
      "fetch_failed",
      `local media-store fetch failed for ${localUrl.pathname}`,
      error,
    );
  }
  if (!response.ok) {
    throw new MediaFetchError(
      "http_error",
      `local media-store fetch failed (HTTP ${response.status}) for ${localUrl.pathname}`,
    );
  }
  const buffer = await readResponseWithLimit(response, maxBytes);
  const contentType =
    response.headers.get("content-type")?.split(";")[0]?.trim() ||
    "application/octet-stream";
  const fileName = localUrl.pathname.split("/").pop();
  return {
    buffer,
    contentType,
    ...(fileName ? { fileName } : {}),
  };
}

/**
 * Resolve outbound attachment bytes. Never treats the URL as a local filesystem
 * path and never falls back to an unguarded http(s) fetch.
 */
export async function resolveOutboundAttachmentBytes(
  url: string,
  opts: ResolveOutboundAttachmentOptions = {},
): Promise<ResolvedOutboundAttachmentBytes> {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new MediaFetchError(
      "fetch_failed",
      "outbound attachment URL is empty",
    );
  }
  const maxBytes = opts.maxBytes ?? DEFAULT_CONNECTOR_ATTACHMENT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_OUTBOUND_TIMEOUT_MS;

  if (trimmed.startsWith("data:")) {
    return decodeDataUrl(trimmed, maxBytes);
  }

  const localUrl = trustedLocalMediaUrl(trimmed);
  if (localUrl) {
    return fetchLocalMediaStoreBytes(localUrl, opts, maxBytes, timeoutMs);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (error) {
    // error-policy:J3 non-URL filesystem paths and opaque strings are invalid
    // outbound attachments; they must not be read from disk.
    throw new MediaFetchError(
      "fetch_failed",
      "outbound attachment URL is not a data URL, media-store handle, or http(s) URL",
      error,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new MediaFetchError(
      "fetch_failed",
      "outbound attachment URL is not a data URL, media-store handle, or http(s) URL",
    );
  }

  const fetched = await fetchRemoteMedia({
    url: trimmed,
    maxBytes,
    timeoutMs,
    fetchImpl: opts.fetchImpl,
    lookupFn: opts.lookupFn,
    pinnedFetchImpl: opts.pinnedFetchImpl,
  });
  return {
    buffer: fetched.buffer,
    contentType: fetched.contentType ?? "application/octet-stream",
    ...(fetched.fileName ? { fileName: fetched.fileName } : {}),
  };
}
