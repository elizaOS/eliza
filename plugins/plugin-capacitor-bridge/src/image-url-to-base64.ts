/**
 * Resolves caller-influenced bionic vision image URLs through the canonical
 * guarded media fetch without widening the bridge package's public exports.
 */
import { fetchRemoteMedia } from "@elizaos/core";

// Match the bounds used by the sibling plugin-local-inference vision paths.
const IMAGE_DESCRIPTION_FETCH_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_DESCRIPTION_FETCH_TIMEOUT_MS = 15_000;

/** Resolve a data:/http(s) image URL to base64 image bytes for the host. */
export async function imageUrlToBase64(url: string): Promise<string> {
	if (url.startsWith("data:")) {
		const comma = url.indexOf(",");
		return comma >= 0 ? url.slice(comma + 1) : url;
	}
	try {
		const media = await fetchRemoteMedia({
			url,
			maxBytes: IMAGE_DESCRIPTION_FETCH_MAX_BYTES,
			timeoutMs: IMAGE_DESCRIPTION_FETCH_TIMEOUT_MS,
			maxRedirects: 5,
		});
		return media.buffer.toString("base64");
	} catch (err) {
		// error-policy:J2 context-adding rethrow — preserve guarded-fetch cause
		throw new Error(
			`[mobile-device-bridge] IMAGE_DESCRIPTION failed to fetch ${url}: ${
				err instanceof Error ? err.message : String(err)
			}`,
			{ cause: err },
		);
	}
}
