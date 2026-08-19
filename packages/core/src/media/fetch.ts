/**
 * Fetches remote media through DNS-pinned SSRF protection, enforces byte
 * limits, and derives safe filenames and MIME metadata.
 */

import {
	fetchWithSsrfGuard,
	type LookupFn,
	type PinnedLookupFetchLike,
	type SsrfPolicy,
} from "../network/index.js";
import { detectMime, extensionForMime } from "./mime.js";

export type FetchMediaResult = {
	buffer: Buffer;
	contentType?: string;
	fileName?: string;
};

export type MediaFetchErrorCode =
	| "max_bytes"
	| "http_error"
	| "fetch_failed"
	| "invalid_response";

export class MediaFetchError extends Error {
	readonly code: MediaFetchErrorCode;

	constructor(code: MediaFetchErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.code = code;
		this.name = "MediaFetchError";
	}
}

export type FetchLike = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export type FetchMediaOptions = {
	url: string;
	fetchImpl?: FetchLike;
	filePathHint?: string;
	maxBytes?: number;
	maxRedirects?: number;
	timeoutMs?: number;
	/** Require the declared response MIME type to start with this prefix. */
	requiredContentTypePrefix?: string;
	/** Reject Content-Encoding other than identity when callers need raw media bytes. */
	rejectContentEncoding?: boolean;
	ssrfPolicy?: SsrfPolicy;
	lookupFn?: LookupFn;
	pinnedFetchImpl?: PinnedLookupFetchLike;
};

function stripQuotes(value: string): string {
	return value.replace(/^["']|["']$/g, "");
}

function getBasename(p: string): string {
	return p.split(/[\\/]/).pop() || "";
}
function getExtname(p: string): string {
	const base = getBasename(p);
	const match = base.match(/\.[^.]+$/);
	return match ? match[0] : "";
}

function parseContentDispositionFileName(
	header?: string | null,
): string | undefined {
	if (!header) {
		return undefined;
	}
	const starMatch = /filename\*\s*=\s*([^;]+)/i.exec(header);
	if (starMatch?.[1]) {
		const cleaned = stripQuotes(starMatch[1].trim());
		// RFC 5987 ext-value is `charset'language'value` where the language
		// tag is optional but both single quotes are mandatory, e.g.
		// `UTF-8''na%C3%AFve.txt` or `UTF-8'en'na%C3%AFve.txt`. Strip the
		// charset/language prefix whether or not a language tag is present;
		// splitting on `''` only handled the empty-language form and leaked
		// `UTF-8'en'` into the filename otherwise.
		const extValueMatch = /^([^']*)'([^']*)'([\s\S]*)$/.exec(cleaned);
		const encoded = extValueMatch ? extValueMatch[3] : cleaned;
		try {
			return getBasename(decodeURIComponent(encoded));
		} catch {
			// error-policy:J3 Malformed RFC 5987 encoding is untrusted header
			// input; retain only its basename as the sanitized invalid fallback.
			return getBasename(encoded);
		}
	}
	const match = /filename\s*=\s*([^;]+)/i.exec(header);
	if (match?.[1]) {
		return getBasename(stripQuotes(match[1].trim()));
	}
	return undefined;
}

async function readErrorBodySnippet(
	res: Response,
	maxChars = 200,
): Promise<string | undefined> {
	try {
		// Bound diagnostics too: an error response is still an untrusted body and
		// must not bypass the caller's successful-response byte limit.
		const text = (await readResponseWithLimit(res, maxChars)).toString("utf8");
		if (!text) {
			return undefined;
		}
		const collapsed = text.replace(/\s+/g, " ").trim();
		if (!collapsed) {
			return undefined;
		}
		if (collapsed.length <= maxChars) {
			return collapsed;
		}
		return `${collapsed.slice(0, maxChars - 1)}…`;
	} catch {
		// error-policy:J7 The HTTP status remains authoritative when its optional
		// diagnostic body snippet cannot be read.
		return undefined;
	}
}

function enforceResponsePolicy(
	res: Response,
	url: string,
	options: FetchMediaOptions,
): void {
	const requiredPrefix = options.requiredContentTypePrefix
		?.trim()
		.toLowerCase();
	if (requiredPrefix) {
		const declared = res.headers.get("content-type")?.trim().toLowerCase();
		if (!declared?.startsWith(requiredPrefix)) {
			throw new MediaFetchError(
				"invalid_response",
				`Failed to fetch media from ${url}: expected Content-Type starting with ${requiredPrefix}`,
			);
		}
	}

	if (options.rejectContentEncoding) {
		const encoding = res.headers.get("content-encoding")?.trim().toLowerCase();
		if (encoding && encoding !== "identity") {
			throw new MediaFetchError(
				"invalid_response",
				`Failed to fetch media from ${url}: encoded response bodies are not accepted`,
			);
		}
	}
}

async function fetchGuardedMedia(options: FetchMediaOptions): Promise<{
	response: Response;
	finalUrl: string;
	release: () => Promise<void>;
}> {
	try {
		return await fetchWithSsrfGuard({
			url: options.url,
			fetchImpl: options.fetchImpl,
			maxRedirects: options.maxRedirects,
			timeoutMs: options.timeoutMs,
			policy: options.ssrfPolicy,
			lookupFn: options.lookupFn,
			pinnedFetchImpl: options.pinnedFetchImpl,
		});
	} catch (err) {
		// error-policy:J2 Add media URL context while preserving the guarded-fetch cause.
		throw new MediaFetchError(
			"fetch_failed",
			`Failed to fetch media from ${options.url}: ${String(err)}`,
			err,
		);
	}
}

async function throwIfHttpError(
	res: Response,
	url: string,
	finalUrl: string,
): Promise<void> {
	if (res.ok) {
		return;
	}

	const statusText = res.statusText ? ` ${res.statusText}` : "";
	const redirected = finalUrl !== url ? ` (redirected to ${finalUrl})` : "";
	let detail = `HTTP ${res.status}${statusText}`;
	if (!res.body) {
		detail = `HTTP ${res.status}${statusText}; empty response body`;
	} else {
		const snippet = await readErrorBodySnippet(res);
		if (snippet) {
			detail += `; body: ${snippet}`;
		}
	}
	throw new MediaFetchError(
		"http_error",
		`Failed to fetch media from ${url}${redirected}: ${detail}`,
	);
}

function enforceContentLengthLimit(
	res: Response,
	url: string,
	maxBytes?: number,
): void {
	const contentLength = res.headers.get("content-length");
	if (maxBytes === undefined || !contentLength) {
		return;
	}

	const length = Number(contentLength);
	if (Number.isFinite(length) && length > maxBytes) {
		throw new MediaFetchError(
			"max_bytes",
			`Failed to fetch media from ${url}: content length ${length} exceeds maxBytes ${maxBytes}`,
		);
	}
}

function fileNameFromUrl(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		const base = getBasename(parsed.pathname);
		return base || undefined;
	} catch {
		// error-policy:J3 Redirect-derived URL text is untrusted; absence of a
		// filename is an explicit invalid result.
		return undefined;
	}
}

async function resolveMediaMetadata(params: {
	res: Response;
	buffer: Buffer;
	finalUrl: string;
	filePathHint?: string;
}): Promise<Pick<FetchMediaResult, "contentType" | "fileName">> {
	const { res, buffer, finalUrl, filePathHint } = params;
	const headerFileName = parseContentDispositionFileName(
		res.headers.get("content-disposition"),
	);
	let fileName =
		headerFileName ||
		fileNameFromUrl(finalUrl) ||
		(filePathHint ? getBasename(filePathHint) : undefined);

	const filePathForMime =
		headerFileName && getExtname(headerFileName)
			? headerFileName
			: (filePathHint ?? finalUrl);
	const contentType = await detectMime({
		buffer,
		headerMime: res.headers.get("content-type"),
		filePath: filePathForMime,
	});
	if (fileName && !getExtname(fileName) && contentType) {
		const ext = extensionForMime(contentType);
		if (ext) {
			fileName = `${fileName}${ext}`;
		}
	}

	return {
		contentType: contentType ?? undefined,
		fileName,
	};
}

/**
 * Fetch remote media with SSRF protection.
 *
 * @param options - Fetch options
 * @returns Promise resolving to buffer, content type, and filename
 * @throws MediaFetchError on fetch failures
 */
export async function fetchRemoteMedia(
	options: FetchMediaOptions,
): Promise<FetchMediaResult> {
	const { response: res, finalUrl, release } = await fetchGuardedMedia(options);

	try {
		await throwIfHttpError(res, options.url, finalUrl);
		enforceResponsePolicy(res, options.url, options);
		enforceContentLengthLimit(res, options.url, options.maxBytes);

		const buffer =
			options.maxBytes !== undefined
				? await readResponseWithLimit(res, options.maxBytes)
				: Buffer.from(await res.arrayBuffer());
		const metadata = await resolveMediaMetadata({
			res,
			buffer,
			finalUrl,
			filePathHint: options.filePathHint,
		});

		return {
			buffer,
			...metadata,
		};
	} finally {
		try {
			await res.body?.cancel();
		} catch {
			// error-policy:J6 The result or primary fetch failure is authoritative;
			// cancelling a rejected or already-consumed body is best-effort teardown.
		}
		await release();
	}
}

/**
 * Reads a response body under a hard byte cap, cancelling the stream as soon
 * as the running total exceeds maxBytes instead of materializing the payload
 * first — so a missing or lying Content-Length can never force an unbounded
 * allocation. Shared by the remote media fetcher above and the trusted local
 * attachment byte-fetches (ingest enrichment and on-demand transcription).
 * Falls back to a post-read check only when the response exposes no stream.
 * Throws MediaFetchError("max_bytes") on overflow.
 */
export async function readResponseWithLimit(
	res: Response,
	maxBytes: number,
): Promise<Buffer> {
	const body = res.body;
	if (!body) {
		const fallback = Buffer.from(await res.arrayBuffer());
		if (fallback.length > maxBytes) {
			throw new MediaFetchError(
				"max_bytes",
				`Failed to fetch media from ${res.url || "response"}: payload exceeds maxBytes ${maxBytes}`,
			);
		}
		return fallback;
	}

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (value.length) {
				total += value.length;
				if (total > maxBytes) {
					try {
						await reader.cancel();
					} catch {
						// error-policy:J6 Cancellation is best-effort after the
						// byte-limit failure has already been established.
						// ignore cancel errors
					}
					throw new MediaFetchError(
						"max_bytes",
						`Failed to fetch media from ${res.url || "response"}: payload exceeds maxBytes ${maxBytes}`,
					);
				}
				chunks.push(value);
			}
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// error-policy:J6 Stream lock release is best-effort teardown.
			// ignore release errors
		}
	}

	return Buffer.concat(
		chunks.map((chunk) => Buffer.from(chunk)),
		total,
	);
}
