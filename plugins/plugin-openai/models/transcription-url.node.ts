/**
 * Node transcription-URL boundary: routes caller-supplied audio URLs through
 * core's DNS-pinned `fetchRemoteMedia` SSRF guard. Only `index.node.ts`
 * reaches this module, which keeps the `@elizaos/core/node` subpath — and the
 * Node built-ins behind it — out of the browser bundle (#18702).
 */
import {
  installTranscriptionUrlFetcher,
  TRANSCRIPTION_AUDIO_FETCH_TIMEOUT_MS,
  TRANSCRIPTION_AUDIO_MAX_BYTES,
  TRANSCRIPTION_AUDIO_MAX_REDIRECTS,
  toAudioBlob,
} from "./transcription-url";

export function installNodeTranscriptionUrlFetcher(): void {
  installTranscriptionUrlFetcher(async (url) => {
    // Load lazily so the heavy node entry is paid for only on the URL path.
    // @trajectory-allow Fetches caller-provided audio bytes; no model inference happens here.
    const { fetchRemoteMedia } = await import("@elizaos/core/node");
    const media = await fetchRemoteMedia({
      url,
      maxBytes: TRANSCRIPTION_AUDIO_MAX_BYTES,
      timeoutMs: TRANSCRIPTION_AUDIO_FETCH_TIMEOUT_MS,
      maxRedirects: TRANSCRIPTION_AUDIO_MAX_REDIRECTS,
    });
    return toAudioBlob(media.buffer, media.contentType);
  });
}
