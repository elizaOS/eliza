/**
 * Node image-URL boundary: routes caller-supplied image URLs through core's
 * DNS-pinned `fetchRemoteMedia` SSRF guard. Only `index.node.ts` reaches this
 * module, which keeps the `@elizaos/core/node` subpath — and the Node
 * built-ins behind it — out of the browser bundle (#18699).
 */
import {
  IMAGE_DESCRIPTION_FETCH_TIMEOUT_MS,
  IMAGE_DESCRIPTION_MAX_BYTES,
  IMAGE_DESCRIPTION_MAX_REDIRECTS,
  installImageUrlFetcher,
} from "./image-url";

export function installNodeImageUrlFetcher(): void {
  installImageUrlFetcher(async (url) => {
    // Load lazily so the heavy node entry is paid for only on the URL path.
    // @trajectory-allow Fetches caller-provided image bytes; no model inference happens here.
    const { fetchRemoteMedia } = await import("@elizaos/core/node");
    const media = await fetchRemoteMedia({
      url,
      maxBytes: IMAGE_DESCRIPTION_MAX_BYTES,
      timeoutMs: IMAGE_DESCRIPTION_FETCH_TIMEOUT_MS,
      maxRedirects: IMAGE_DESCRIPTION_MAX_REDIRECTS,
    });
    return {
      base64: media.buffer.toString("base64"),
      contentType: media.contentType,
    };
  });
}
