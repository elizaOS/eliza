/**
 * Platform-split boundary for TRANSCRIPTION audio-URL loading. `models/audio.ts`
 * is shared by both build targets, so it must never name a platform-specific
 * core subpath; instead each build entrypoint (`index.node.ts` /
 * `index.browser.ts`) installs its guarded fetcher here before the plugin is
 * importable. Loading a URL with no installed fetcher fails closed rather than
 * falling back to an unguarded fetch.
 */
import { detectAudioMimeType } from "../utils/audio";

/** OpenAI Whisper/upload limit is 25 MB; keep the same hard cap server-side. */
export const TRANSCRIPTION_AUDIO_MAX_BYTES = 25 * 1024 * 1024;
export const TRANSCRIPTION_AUDIO_FETCH_TIMEOUT_MS = 30_000;
export const TRANSCRIPTION_AUDIO_MAX_REDIRECTS = 5;

export type TranscriptionUrlFetcher = (url: string) => Promise<Blob>;

let platformFetcher: TranscriptionUrlFetcher | null = null;

export function installTranscriptionUrlFetcher(fetcher: TranscriptionUrlFetcher): void {
  platformFetcher = fetcher;
}

/** Wrap fetched audio bytes in a Blob, trusting an `audio/*` content type and sniffing otherwise. */
export function toAudioBlob(bytes: Uint8Array, contentType?: string | null): Blob {
  const mimeType = contentType?.startsWith("audio/") ? contentType : detectAudioMimeType(bytes);
  return new Blob([new Uint8Array(bytes)], { type: mimeType });
}

export async function fetchAudioFromUrl(url: string): Promise<Blob> {
  if (!url || url.trim().length === 0) {
    throw new Error("TRANSCRIPTION requires a valid audio URL");
  }
  if (!platformFetcher) {
    throw new Error(
      "TRANSCRIPTION audio URLs require the platform build entrypoint (node or browser) to install its guarded fetcher"
    );
  }
  return platformFetcher(url);
}
