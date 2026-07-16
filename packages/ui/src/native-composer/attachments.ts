/**
 * Normalizes a decoded {@link ComposerAttachmentSource} into a
 * {@link ComposerAttachment} expressed purely in the existing content-addressed
 * media store's vocabulary — a `data:` URL (persisted to the store on send by the
 * outgoing pipeline in `api/media-runtime.ts`), a remote http(s) URL flagged for
 * server-side SSRF-guarded rehost, or an already-stored `/api/media/<hash>` URL.
 *
 * This is the "route attachments through the existing store, add no second store"
 * seam on the renderer side: it produces no file id and no bespoke handle, only a
 * URL the existing send path already knows how to persist. Oversized or malformed
 * bytes are rejected with a typed reason (never a fabricated attachment), so a bad
 * source stops here instead of becoming a broken tile downstream.
 *
 * The private-host check on `remote` is a fast first-line guard for obvious
 * loopback/RFC-1918 literals; it is NOT the authority. The server's DNS-pinned
 * SSRF guard (`packages/core/src/network`, driven by `fetchRemoteMedia`) makes the
 * binding decision at rehost time.
 */

import type {
  ComposerAttachment,
  ComposerAttachmentSource,
  ComposerRejectReason,
} from "./contract";

/** Default hard cap on inline attachment bytes; mirrors the store's rehost cap. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** Served-media URL prefix; a `stored` source must already point here. */
const STORED_MEDIA_PREFIX = "/api/media/";
/** `<sha256>.<ext>` — the store's content-addressed file name shape. */
const STORED_MEDIA_NAME = /^[a-f0-9]{64}\.[a-z0-9]+$/i;

export interface NormalizeAttachmentOptions {
  /** Reject inline/data-url bytes larger than this (default 50 MiB). */
  maxBytes?: number;
}

export type NormalizeAttachmentResult =
  | { ok: true; attachment: ComposerAttachment }
  | { ok: false; reason: ComposerRejectReason; message: string };

function reject(
  reason: ComposerRejectReason,
  message: string,
): { ok: false; reason: ComposerRejectReason; message: string } {
  return { ok: false, reason, message };
}

/** A mime is well-formed iff it is `type/subtype` with non-empty halves. */
function isWellFormedMime(mime: string): boolean {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mime);
}

/** Decoded byte length of a standard/loose base64 payload (whitespace stripped). */
function base64ByteLength(base64: string): number | null {
  const cleaned = base64.replace(/\s+/g, "");
  if (cleaned.length === 0) return 0;
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(cleaned)) return null;
  const padding = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
  return Math.floor((cleaned.length * 3) / 4) - padding;
}

/**
 * True for a hostname that is a loopback or RFC-1918/link-local literal, or has
 * no dot (bare host / `.local`) — the obvious SSRF footguns worth rejecting
 * before a round-trip. Authoritative blocking is the server's DNS-pinned guard.
 */
function isObviouslyPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || host === "::1") return true;
  if (host.endsWith(".local") || !host.includes(".")) return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80"))
    return true;
  return false;
}

function parseDataUrlMime(dataUrl: string): string | undefined {
  const header = dataUrl.slice("data:".length).split(",", 1)[0] ?? "";
  const mime = header.split(";", 1)[0]?.trim();
  return mime && mime.length > 0 ? mime : undefined;
}

/** Upper-bound byte size of a `data:` URL payload (base64 or percent/plain). */
function dataUrlByteLength(dataUrl: string): number | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const header = dataUrl.slice("data:".length, comma);
  const payload = dataUrl.slice(comma + 1);
  if (/;base64/i.test(header)) return base64ByteLength(payload);
  // Percent/plain-encoded payloads are at most their encoded length in bytes.
  return payload.length;
}

/**
 * Normalize one attachment source into the media-store vocabulary, or reject it
 * with a typed reason. The decoder has already validated field shapes; this adds
 * the semantic checks the store cares about: a well-formed mime and a byte cap.
 */
export function normalizeComposerAttachment(
  id: string,
  source: ComposerAttachmentSource,
  options: NormalizeAttachmentOptions = {},
): NormalizeAttachmentResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;

  switch (source.source) {
    case "inline": {
      if (!isWellFormedMime(source.mimeType))
        return reject("invalid-input", `malformed mime: ${source.mimeType}`);
      const bytes = base64ByteLength(source.bytesBase64);
      if (bytes === null)
        return reject("invalid-input", "attachment bytes are not valid base64");
      if (bytes === 0)
        return reject("invalid-input", "attachment has no bytes");
      if (bytes > maxBytes)
        return reject(
          "oversized",
          `attachment ${bytes}B exceeds cap ${maxBytes}B`,
        );
      return {
        ok: true,
        attachment: {
          id,
          url: `data:${source.mimeType};base64,${source.bytesBase64.replace(/\s+/g, "")}`,
          mimeType: source.mimeType,
          ...(source.name ? { name: source.name } : {}),
          kind: "inline",
          status: "ready",
        },
      };
    }
    case "data-url": {
      const mime = parseDataUrlMime(source.dataUrl);
      if (!mime || !isWellFormedMime(mime))
        return reject("invalid-input", "data URL has no valid mediatype");
      const bytes = dataUrlByteLength(source.dataUrl);
      if (bytes === null)
        return reject("invalid-input", "data URL payload is malformed");
      if (bytes === 0) return reject("invalid-input", "data URL has no bytes");
      if (bytes > maxBytes)
        return reject(
          "oversized",
          `attachment ${bytes}B exceeds cap ${maxBytes}B`,
        );
      return {
        ok: true,
        attachment: {
          id,
          url: source.dataUrl,
          mimeType: mime,
          ...(source.name ? { name: source.name } : {}),
          kind: "inline",
          status: "ready",
        },
      };
    }
    case "remote": {
      let parsed: URL;
      try {
        parsed = new URL(source.url);
      } catch {
        return reject("invalid-input", `not a valid URL: ${source.url}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        return reject("unsupported", `unsupported scheme: ${parsed.protocol}`);
      if (isObviouslyPrivateHost(parsed.hostname))
        return reject(
          "permission-denied",
          `blocked private host: ${parsed.hostname}`,
        );
      return {
        ok: true,
        attachment: {
          id,
          url: source.url,
          ...(source.mimeType ? { mimeType: source.mimeType } : {}),
          ...(source.name ? { name: source.name } : {}),
          kind: "remote",
          // Awaits the server's SSRF-guarded rehost on send; not yet in the store.
          status: "pending-rehost",
        },
      };
    }
    case "stored": {
      const name = source.url.startsWith(STORED_MEDIA_PREFIX)
        ? source.url.slice(STORED_MEDIA_PREFIX.length).split(/[?#]/)[0]
        : "";
      if (!name || !STORED_MEDIA_NAME.test(name))
        return reject("invalid-input", `not a stored media URL: ${source.url}`);
      return {
        ok: true,
        attachment: {
          id,
          url: source.url,
          ...(source.mimeType ? { mimeType: source.mimeType } : {}),
          kind: "stored",
          status: "ready",
        },
      };
    }
  }
}
