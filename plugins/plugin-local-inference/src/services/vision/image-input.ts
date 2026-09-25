/**
 * Resolves canonical runtime-owned media URLs before vision backend dispatch.
 * Local content-addressed handles use the runtime fetch; every other URL stays
 * remote so the backend's shared SSRF guard remains authoritative.
 */

import {
	getLocalServerUrl,
	type IAgentRuntime,
	MediaFetchError,
	readResponseWithLimit,
} from "@elizaos/core";
import type { VisionImageInput } from "./types.js";

export const VISION_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const VISION_IMAGE_FETCH_TIMEOUT_MS = 15_000;

const LOCAL_MEDIA_STORE_PATH = /^\/api\/media\/[a-f0-9]{64}\.[a-z0-9]{1,8}$/;

function trustedLocalMediaUrl(rawUrl: string): URL | null {
	const url = rawUrl.trim();
	if (url.startsWith("/")) {
		if (!url.startsWith("/api/media/")) {
			return null;
		}
		if (!LOCAL_MEDIA_STORE_PATH.test(url)) {
			throw new MediaFetchError(
				"fetch_failed",
				"IMAGE_DESCRIPTION local media URL is not canonical",
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
			"IMAGE_DESCRIPTION local media URL is not canonical",
		);
	}
	return parsed;
}

/**
 * Convert a trusted local media-store URL to bounded bytes. Remote inputs are
 * deliberately returned unchanged for the backend's SSRF-guarded resolver.
 */
export async function prepareVisionImageInput(
	runtime: IAgentRuntime,
	input: VisionImageInput,
	options: { signal?: AbortSignal } = {},
): Promise<VisionImageInput> {
	if (input.kind !== "url") {
		return input;
	}
	const localUrl = trustedLocalMediaUrl(input.url);
	if (!localUrl) {
		return input;
	}

	const runtimeFetch = runtime.fetch ?? globalThis.fetch;
	const timeoutSignal = AbortSignal.timeout(VISION_IMAGE_FETCH_TIMEOUT_MS);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeoutSignal])
		: timeoutSignal;
	try {
		const response = await runtimeFetch(localUrl.href, { signal });
		if (!response.ok) {
			throw new MediaFetchError(
				"http_error",
				`IMAGE_DESCRIPTION local media fetch failed (HTTP ${response.status})`,
			);
		}
		const contentLength = response.headers.get("content-length");
		if (
			contentLength !== null &&
			Number.isFinite(Number(contentLength)) &&
			Number(contentLength) > VISION_IMAGE_MAX_BYTES
		) {
			throw new MediaFetchError(
				"max_bytes",
				`IMAGE_DESCRIPTION image exceeds ${VISION_IMAGE_MAX_BYTES} bytes`,
			);
		}
		const buffer = await readResponseWithLimit(
			response,
			VISION_IMAGE_MAX_BYTES,
		);
		return {
			kind: "bytes",
			bytes: new Uint8Array(buffer),
			mimeType:
				input.mimeType ??
				response.headers.get("content-type") ??
				"application/octet-stream",
		};
	} catch (error) {
		// error-policy:J2 Preserve the typed media failure while adding a stable
		// local vision-fetch boundary for transport and stream errors.
		if (error instanceof Error && error.name === "MediaFetchError") {
			throw error;
		}
		throw new MediaFetchError(
			"fetch_failed",
			"IMAGE_DESCRIPTION local media fetch failed",
			error,
		);
	}
}
