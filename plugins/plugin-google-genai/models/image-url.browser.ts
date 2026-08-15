/**
 * Browser image-URL boundary: a guarded fetch with no Node subpaths so
 * browser-target consumer bundles can load the documented URL path (#18699).
 * It fails closed on literal loopback/private/link-local/metadata hosts before
 * the request using the same core SSRF policy helpers the Node guard uses,
 * refuses redirects outright (`redirect: "error"`) so no hop request is ever
 * issued, fails closed when the response exposes no final URL, enforces the
 * shared byte cap while streaming, and bounds wall time with an abort timer.
 * A browser cannot pin DNS, so rebinding defense remains a Node-path property;
 * same-origin policy/CORS bounds what a page can read.
 */
import {
  isBlockedHostname,
  isPrivateIpAddress,
  SsrfBlockedError,
} from "@elizaos/core";
import {
  IMAGE_DESCRIPTION_FETCH_TIMEOUT_MS,
  IMAGE_DESCRIPTION_MAX_BYTES,
  installImageUrlFetcher,
} from "./image-url";

function assertAllowedImageUrl(raw: string, context: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error) {
    // error-policy:J3 URL text is untrusted input; reject it explicitly.
    throw new Error(`Invalid ${context}: must be http or https`, {
      cause: error,
    });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Invalid ${context}: must be http or https`);
  }
  if (
    isBlockedHostname(parsed.hostname) ||
    isPrivateIpAddress(parsed.hostname)
  ) {
    throw new SsrfBlockedError(`Blocked ${context} host: ${parsed.hostname}`);
  }
  return parsed;
}

async function readBodyWithByteCap(
  response: Response,
  url: string,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const length = Number(contentLength);
    if (Number.isFinite(length) && length > IMAGE_DESCRIPTION_MAX_BYTES) {
      throw new Error(
        `Failed to fetch image from ${url}: content length ${length} exceeds maxBytes ${IMAGE_DESCRIPTION_MAX_BYTES}`,
      );
    }
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > IMAGE_DESCRIPTION_MAX_BYTES) {
      throw new Error(
        `Failed to fetch image from ${url}: body exceeds maxBytes ${IMAGE_DESCRIPTION_MAX_BYTES}`,
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
    if (total > IMAGE_DESCRIPTION_MAX_BYTES) {
      await reader.cancel();
      throw new Error(
        `Failed to fetch image from ${url}: body exceeds maxBytes ${IMAGE_DESCRIPTION_MAX_BYTES}`,
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

/** Base64-encode without Buffer: chunked `btoa` stays under argument limits. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function installBrowserImageUrlFetcher(): void {
  installImageUrlFetcher(async (url) => {
    const parsed = assertAllowedImageUrl(url, "image URL");
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      IMAGE_DESCRIPTION_FETCH_TIMEOUT_MS,
    );
    try {
      // The Fetch Standard performs redirect hops before fetch() resolves, so
      // a landing-host recheck runs only after the hop request was already
      // sent. "error" makes any redirect a network failure with no hop issued.
      const response = await fetch(parsed.toString(), {
        redirect: "error",
        signal: controller.signal,
      });
      // Defense in depth: the response must still land on an allowed host,
      // and a missing final URL is opaque, so it fails closed too.
      if (!response.url) {
        await response.body?.cancel();
        throw new SsrfBlockedError(
          "Blocked image redirect target: missing final URL",
        );
      }
      try {
        assertAllowedImageUrl(response.url, "image redirect target");
      } catch (error) {
        // error-policy:J2 Release the connection before rethrowing the policy failure.
        await response.body?.cancel();
        throw error;
      }
      if (!response.ok) {
        throw new Error(
          `Failed to fetch image from ${url}: HTTP ${response.status} ${response.statusText}`,
        );
      }
      const bytes = await readBodyWithByteCap(response, url);
      return {
        base64: bytesToBase64(bytes),
        contentType: response.headers.get("content-type"),
      };
    } finally {
      clearTimeout(timer);
    }
  });
}
