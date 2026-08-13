/**
 * Platform-split boundary for IMAGE_DESCRIPTION image-URL loading.
 * `models/image.ts` is shared by both build targets, so it must never name a
 * platform-specific core subpath; instead each build entrypoint
 * (`index.node.ts` / `index.browser.ts`) installs its guarded fetcher here
 * before the plugin is importable. Loading a URL with no installed fetcher
 * fails closed rather than falling back to an unguarded fetch (#18699).
 */

/** Cap inline image payloads so a hostile host cannot force unbounded memory. */
export const IMAGE_DESCRIPTION_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_DESCRIPTION_FETCH_TIMEOUT_MS = 15_000;
export const IMAGE_DESCRIPTION_MAX_REDIRECTS = 5;

export type FetchedImage = {
  /** Base64-encoded image bytes, ready for Gemini `inlineData`. */
  base64: string;
  contentType?: string | null;
};

export type ImageUrlFetcher = (url: string) => Promise<FetchedImage>;

let platformFetcher: ImageUrlFetcher | null = null;

export function installImageUrlFetcher(fetcher: ImageUrlFetcher): void {
  platformFetcher = fetcher;
}

export async function fetchImageFromUrl(url: string): Promise<FetchedImage> {
  if (!platformFetcher) {
    throw new Error(
      "IMAGE_DESCRIPTION image URLs require the platform build entrypoint (node or browser) to install its guarded fetcher",
    );
  }
  return platformFetcher(url);
}
