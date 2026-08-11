/**
 * Resolves attachment bytes for model enrichment through one bounded boundary.
 * Remote URLs use the SSRF-guarded transport; only content-addressed local media
 * paths may use the runtime's loopback fetch.
 */

import type { IAgentRuntime } from "../types/runtime.ts";
import { getLocalServerUrl } from "../utils/node.ts";
import {
	fetchRemoteMedia,
	MediaFetchError,
	readResponseWithLimit,
} from "./fetch.ts";

const ATTACHMENT_FETCH_MAX_BYTES = 50 * 1024 * 1024;
const ATTACHMENT_FETCH_TIMEOUT_MS = 30_000;

const STORED_MEDIA_PATH = /^\/api\/media\/[a-f0-9]{64}\.[a-z0-9]{1,8}$/;

function isStoredMediaPath(rawUrl: string): boolean {
	try {
		const base = new URL("http://local.invalid");
		const parsed = new URL(rawUrl, base);
		return (
			parsed.origin === base.origin &&
			STORED_MEDIA_PATH.test(parsed.pathname) &&
			parsed.hash === ""
		);
	} catch {
		// error-policy:J3 Attachment URLs are untrusted serialized input; an
		// unparsable value is explicitly rejected rather than treated as local.
		return false;
	}
}

/**
 * Fetch attachment bytes with the same deadline and byte cap for every
 * enrichment caller. Absolute HTTP(S) URLs stay behind SSRF protection. The
 * only local bypass is the server's strict content-addressed media route.
 */
export async function fetchAttachmentBytes(
	runtime: IAgentRuntime,
	rawUrl: string,
): Promise<{ buffer: Buffer; contentType: string }> {
	if (/^https?:\/\//i.test(rawUrl)) {
		const { buffer, contentType } = await fetchRemoteMedia({
			url: rawUrl,
			maxBytes: ATTACHMENT_FETCH_MAX_BYTES,
			timeoutMs: ATTACHMENT_FETCH_TIMEOUT_MS,
		});
		return {
			buffer,
			contentType: contentType ?? "application/octet-stream",
		};
	}

	if (!isStoredMediaPath(rawUrl)) {
		throw new MediaFetchError(
			"fetch_failed",
			`Attachment URL is not a trusted stored-media path: ${rawUrl}`,
		);
	}

	try {
		const runtimeFetch = runtime.fetch ?? globalThis.fetch;
		const response = await runtimeFetch(getLocalServerUrl(rawUrl), {
			signal: AbortSignal.timeout(ATTACHMENT_FETCH_TIMEOUT_MS),
		});
		if (!response.ok) {
			throw new MediaFetchError(
				"http_error",
				`Failed to fetch stored attachment ${rawUrl}: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
			);
		}
		const buffer = await readResponseWithLimit(
			response,
			ATTACHMENT_FETCH_MAX_BYTES,
		);
		return {
			buffer,
			contentType:
				response.headers.get("content-type") ?? "application/octet-stream",
		};
	} catch (error) {
		if (error instanceof MediaFetchError) throw error;
		// error-policy:J2 Add the trusted media path while preserving the runtime
		// fetch failure as the cause.
		throw new MediaFetchError(
			"fetch_failed",
			`Failed to fetch stored attachment ${rawUrl}: ${String(error)}`,
			error,
		);
	}
}
