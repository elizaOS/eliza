/** Node image loading uses the shared DNS-pinned SSRF boundary. */
const IMAGE_DESCRIPTION_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_DESCRIPTION_FETCH_TIMEOUT_MS = 15_000;
const IMAGE_DESCRIPTION_MAX_REDIRECTS = 5;

export async function fetchImageFromUrl(url: string): Promise<{
  base64: string;
  contentType?: string | null;
}> {
  // @trajectory-allow Fetches caller-provided image bytes, not model inference.
  const { fetchRemoteMedia } = await import("@elizaos/shared/media");
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
}
