/** Node transcription URLs use bounded, DNS-pinned media fetching. */
import { fetchRemoteMedia } from "@elizaos/core";
import { detectAudioMimeType } from "../utils/audio";

/** OpenAI Whisper/upload limit is 25 MB; keep the same hard cap server-side. */
export const TRANSCRIPTION_AUDIO_MAX_BYTES = 25 * 1024 * 1024;
export const TRANSCRIPTION_AUDIO_FETCH_TIMEOUT_MS = 30_000;
export const TRANSCRIPTION_AUDIO_MAX_REDIRECTS = 5;

/** Wrap fetched audio bytes in a Blob, trusting an `audio/*` content type and sniffing otherwise. */
export function toAudioBlob(bytes: Uint8Array, contentType?: string | null): Blob {
  const mimeType = contentType?.startsWith("audio/") ? contentType : detectAudioMimeType(bytes);
  return new Blob([new Uint8Array(bytes)], { type: mimeType });
}

export async function fetchAudioFromUrl(url: string): Promise<Blob> {
  if (!url || url.trim().length === 0) {
    throw new Error("TRANSCRIPTION requires a valid audio URL");
  }
  const media = await fetchRemoteMedia({
    url,
    maxBytes: TRANSCRIPTION_AUDIO_MAX_BYTES,
    timeoutMs: TRANSCRIPTION_AUDIO_FETCH_TIMEOUT_MS,
    maxRedirects: TRANSCRIPTION_AUDIO_MAX_REDIRECTS,
  });
  return toAudioBlob(media.buffer, media.contentType);
}
