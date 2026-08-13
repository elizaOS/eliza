/**
 * Browser transcription-URL boundary: a guarded fetch with no Node subpaths so
 * browser-target consumer bundles can load the documented URL path (#18702).
 * It fails closed on literal loopback/private/link-local/metadata hosts before
 * the request using the same core SSRF policy helpers the Node guard uses,
 * re-validates the final landing host after the browser's opaque redirect
 * handling, enforces the shared byte cap while streaming, and bounds wall time
 * with an abort timer. A browser cannot pin DNS, so rebinding defense remains
 * a Node-path property; same-origin policy/CORS bounds what a page can read.
 */
import { isBlockedHostname, isPrivateIpAddress, SsrfBlockedError } from "@elizaos/core";
import {
  installTranscriptionUrlFetcher,
  TRANSCRIPTION_AUDIO_FETCH_TIMEOUT_MS,
  TRANSCRIPTION_AUDIO_MAX_BYTES,
  toAudioBlob,
} from "./transcription-url";

function assertAllowedAudioUrl(raw: string, context: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error) {
    // error-policy:J3 URL text is untrusted input; reject it explicitly.
    throw new Error(`Invalid ${context}: must be http or https`, { cause: error });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Invalid ${context}: must be http or https`);
  }
  if (isBlockedHostname(parsed.hostname) || isPrivateIpAddress(parsed.hostname)) {
    throw new SsrfBlockedError(`Blocked ${context} host: ${parsed.hostname}`);
  }
  return parsed;
}

async function readBodyWithByteCap(response: Response, url: string): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const length = Number(contentLength);
    if (Number.isFinite(length) && length > TRANSCRIPTION_AUDIO_MAX_BYTES) {
      throw new Error(
        `Failed to fetch audio from ${url}: content length ${length} exceeds maxBytes ${TRANSCRIPTION_AUDIO_MAX_BYTES}`
      );
    }
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > TRANSCRIPTION_AUDIO_MAX_BYTES) {
      throw new Error(
        `Failed to fetch audio from ${url}: body exceeds maxBytes ${TRANSCRIPTION_AUDIO_MAX_BYTES}`
      );
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > TRANSCRIPTION_AUDIO_MAX_BYTES) {
      await reader.cancel();
      throw new Error(
        `Failed to fetch audio from ${url}: body exceeds maxBytes ${TRANSCRIPTION_AUDIO_MAX_BYTES}`
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function installBrowserTranscriptionUrlFetcher(): void {
  installTranscriptionUrlFetcher(async (url) => {
    const parsed = assertAllowedAudioUrl(url, "audio URL");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSCRIPTION_AUDIO_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(parsed.toString(), {
        redirect: "follow",
        signal: controller.signal,
      });
      // The browser follows redirects opaquely; the only observable hop is the
      // final landing URL, so re-run the host policy on it before reading bytes.
      if (response.url) {
        try {
          assertAllowedAudioUrl(response.url, "audio redirect target");
        } catch (error) {
          // error-policy:J2 Release the connection before rethrowing the policy failure.
          await response.body?.cancel();
          throw error;
        }
      }
      if (!response.ok) {
        throw new Error(
          `Failed to fetch audio from ${url}: HTTP ${response.status} ${response.statusText}`
        );
      }
      const bytes = await readBodyWithByteCap(response, url);
      return toAudioBlob(bytes, response.headers.get("content-type"));
    } finally {
      clearTimeout(timer);
    }
  });
}
