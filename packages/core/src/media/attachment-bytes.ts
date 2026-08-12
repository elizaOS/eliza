/**
 * Loads conversation attachment bytes through one bounded transport boundary.
 * Remote URLs use the DNS-pinned SSRF guard; local references are restricted to
 * canonical content-addressed media-store paths before resolving to loopback.
 */

import type { IAgentRuntime } from "../types/runtime.ts";
import { getLocalServerUrl } from "../utils/node.ts";
import {
	cancelMediaStreamBestEffort,
	type FetchMediaResult,
	fetchRemoteMedia,
	MediaFetchError,
	readResponseWithLimit,
} from "./fetch.ts";

export const ATTACHMENT_MEDIA_MAX_BYTES = 50 * 1024 * 1024;
export const ATTACHMENT_MEDIA_TIMEOUT_MS = 30_000;

const LOCAL_MEDIA_STORE_URL = /^\/api\/media\/[a-f0-9]{64}\.[a-z0-9]{1,8}$/;

function isMediaFetchError(error: unknown): error is Error {
	return error instanceof Error && error.name === "MediaFetchError";
}

/**
 * Fetches bytes for attachment enrichment and on-demand transcription. The
 * static local errors deliberately exclude attacker-controlled URL text and
 * response prose so callers can safely classify every failure as retryable.
 */
export async function fetchAttachmentMediaBytes(
	runtime: Pick<IAgentRuntime, "fetch">,
	url: string,
): Promise<FetchMediaResult & { contentType: string }> {
	if (/^https?:\/\//.test(url)) {
		try {
			const result = await fetchRemoteMedia({
				url,
				maxBytes: ATTACHMENT_MEDIA_MAX_BYTES,
				timeoutMs: ATTACHMENT_MEDIA_TIMEOUT_MS,
			});
			return {
				...result,
				contentType: result.contentType ?? "application/octet-stream",
			};
		} catch (error) {
			// error-policy:J2 Normalize the whole guarded remote boundary while
			// preserving typed failures across duplicated module instances.
			if (isMediaFetchError(error)) throw error;
			throw new MediaFetchError(
				"fetch_failed",
				"Failed to fetch attachment remotely",
				error,
			);
		}
	}

	if (!LOCAL_MEDIA_STORE_URL.test(url)) {
		throw new MediaFetchError(
			"fetch_failed",
			"Attachment URL is not a canonical media-store path",
		);
	}

	const localUrl = new URL(getLocalServerUrl(url));
	if (localUrl.hostname !== "localhost" && localUrl.hostname !== "127.0.0.1") {
		throw new MediaFetchError(
			"fetch_failed",
			"Local attachment URL did not resolve to loopback",
		);
	}

	const runtimeFetch = runtime.fetch ?? globalThis.fetch;
	try {
		const response = await runtimeFetch(localUrl.href, {
			signal: AbortSignal.timeout(ATTACHMENT_MEDIA_TIMEOUT_MS),
		});
		if (!response.ok) {
			throw new MediaFetchError(
				"http_error",
				`Failed to fetch attachment locally (HTTP ${response.status})`,
			);
		}

		const declaredLength = Number(response.headers.get("content-length"));
		if (
			Number.isFinite(declaredLength) &&
			declaredLength > ATTACHMENT_MEDIA_MAX_BYTES
		) {
			cancelMediaStreamBestEffort(
				response.body,
				"attachment-local-content-length",
			);
			throw new MediaFetchError(
				"max_bytes",
				`Attachment exceeds ${ATTACHMENT_MEDIA_MAX_BYTES} bytes`,
			);
		}

		return {
			buffer: await readResponseWithLimit(response, ATTACHMENT_MEDIA_MAX_BYTES),
			contentType:
				response.headers.get("content-type") ?? "application/octet-stream",
		};
	} catch (error) {
		// error-policy:J2 Normalize the entire trusted local read boundary into
		// the same typed retryable failure family used by the remote transport.
		if (isMediaFetchError(error)) throw error;
		throw new MediaFetchError(
			"fetch_failed",
			"Failed to fetch attachment locally",
			error,
		);
	}
}
