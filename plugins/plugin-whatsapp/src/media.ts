/**
 * Stages remote WhatsApp attachments through core's DNS-pinned SSRF boundary
 * before the bytes are handed to Baileys.
 */
import { type FetchMediaOptions, type FetchMediaResult, fetchRemoteMedia } from "@elizaos/core";

export const DEFAULT_WHATSAPP_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_WHATSAPP_MEDIA_TIMEOUT_MS = 30_000;

type WhatsAppMediaFetchOverrides = Omit<FetchMediaOptions, "url">;

/** Fetch one remote attachment with redirect, DNS/IP, timeout, and size guards. */
export async function stageWhatsAppMedia(
  url: string,
  overrides: WhatsAppMediaFetchOverrides = {}
): Promise<FetchMediaResult> {
  return fetchRemoteMedia({
    maxBytes: DEFAULT_WHATSAPP_MEDIA_MAX_BYTES,
    maxRedirects: 3,
    timeoutMs: DEFAULT_WHATSAPP_MEDIA_TIMEOUT_MS,
    ...overrides,
    url,
  });
}
