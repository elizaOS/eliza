/**
 * Stages WhatsApp attachments before Baileys receives bytes: canonical local
 * handles use runtime fetch, while remote URLs cross core's DNS-pinned guard.
 */
import {
  type FetchMediaOptions,
  type FetchMediaResult,
  fetchRemoteMedia,
  readResponseWithLimit,
} from "@elizaos/core";

export const DEFAULT_WHATSAPP_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_WHATSAPP_MEDIA_TIMEOUT_MS = 30_000;

type WhatsAppMediaFetchOverrides = Omit<FetchMediaOptions, "url">;

const CANONICAL_STORED_MEDIA_URL = /^\/api\/media\/([a-f0-9]{64}\.[a-z0-9]+)(?:\?[^#]*)?$/;

/** Only the content-addressed agent-store capability path is trusted as local media. */
export function isCanonicalStoredMediaUrl(url: string): boolean {
  return CANONICAL_STORED_MEDIA_URL.test(url);
}

/** Fetch one remote attachment with redirect, DNS/IP, timeout, and size guards. */
export async function stageWhatsAppMedia(
  url: string,
  overrides: WhatsAppMediaFetchOverrides = {},
  trustedLocalFetch?: typeof fetch | null
): Promise<FetchMediaResult> {
  const localMatch = CANONICAL_STORED_MEDIA_URL.exec(url);
  if (localMatch) {
    if (!trustedLocalFetch) {
      throw new Error("Canonical WhatsApp media requires the runtime local fetch boundary");
    }
    const maxBytes = overrides.maxBytes ?? DEFAULT_WHATSAPP_MEDIA_MAX_BYTES;
    const timeoutMs = overrides.timeoutMs ?? DEFAULT_WHATSAPP_MEDIA_TIMEOUT_MS;
    const response = await trustedLocalFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      throw new Error(`Canonical WhatsApp media fetch failed with HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`Canonical WhatsApp media exceeds maxBytes ${maxBytes}`);
    }
    return {
      buffer: await readResponseWithLimit(response, maxBytes),
      contentType: response.headers.get("content-type") ?? undefined,
      fileName: localMatch[1],
    };
  }
  return fetchRemoteMedia({
    maxBytes: DEFAULT_WHATSAPP_MEDIA_MAX_BYTES,
    maxRedirects: 3,
    timeoutMs: DEFAULT_WHATSAPP_MEDIA_TIMEOUT_MS,
    ...overrides,
    url,
  });
}
