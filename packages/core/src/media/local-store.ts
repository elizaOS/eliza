/**
 * Canonical agent-owned media-store URL recognition, shared by every caller
 * that fetches attachment bytes with the trusted runtime fetch instead of the
 * remote SSRF-guarded fetcher. Only exact content-addressed store handles
 * (`/api/media/<sha256>.<ext>`, or the same path on the agent's own server
 * origin) qualify — credentials, query strings, fragments, and every other
 * path are rejected so a persisted attachment row can never induce an
 * authenticated internal request. Mirrors the boundary predicate used at the
 * local-inference vision input (#18760); keep the two in sync by importing
 * this module rather than re-deriving the pattern.
 */
import { getLocalServerUrl } from "../utils/node.ts";
import { MediaFetchError } from "./fetch.ts";

/** Shared byte cap for vision image inputs across caller and handler paths. */
export const VISION_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** Shared timeout for trusted-local vision image fetches. */
export const VISION_IMAGE_FETCH_TIMEOUT_MS = 15_000;

const LOCAL_MEDIA_STORE_PATH = /^\/api\/media\/[a-f0-9]{64}\.[a-z0-9]{1,8}$/;

/**
 * Resolve a trusted local media-store URL.
 *
 * Returns the resolved local URL for a canonical store handle, `null` when
 * the URL is not local (callers route those through the SSRF-guarded remote
 * fetcher), and throws `MediaFetchError` for local-looking URLs that are not
 * canonical handles (non-store `/api/media/…` shapes, credentials, query,
 * fragment) so they can never be silently fetched with runtime authority.
 */
export function trustedLocalMediaUrl(rawUrl: string): URL | null {
	const url = rawUrl.trim();
	if (url.startsWith("/")) {
		if (!url.startsWith("/api/media/")) {
			return null;
		}
		if (!LOCAL_MEDIA_STORE_PATH.test(url)) {
			throw new MediaFetchError(
				"fetch_failed",
				"local media URL is not a canonical media-store handle",
			);
		}
		return new URL(getLocalServerUrl(url));
	}

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}

	const localOrigin = new URL(getLocalServerUrl("/")).origin;
	if (parsed.origin !== localOrigin) {
		return null;
	}
	if (
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash ||
		!LOCAL_MEDIA_STORE_PATH.test(parsed.pathname)
	) {
		throw new MediaFetchError(
			"fetch_failed",
			"own-origin media URL is not a canonical media-store handle",
		);
	}
	return parsed;
}
