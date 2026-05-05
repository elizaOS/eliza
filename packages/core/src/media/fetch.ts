/**
 * Media fetching utilities with SSRF protection.
 *
 * Provides secure remote media fetching with:
 * - SSRF protection via DNS pinning
 * - Content-Disposition parsing
 * - Size limits
 * - MIME type detection
 */

import {
	fetchWithSsrfGuard,
	type LookupFn,
	type SsrfPolicy,
} from "../network/index.js";
import { detectMime, extensionForMime } from "./mime.js";

export type FetchMediaResult = {
	buffer: Buffer;
	contentType?: string;
	fileName?: string;
};

export type MediaFetchErrorCode = "max_bytes" | "http_error" | "fetch_failed";

export class MediaFetchError extends Error {
	readonly code: MediaFetchErrorCode;

	constructor(code: MediaFetchErrorCode, message: string) {
		super(message);
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
	ssrfPolicy?: SsrfPolicy;
	lookupFn?: LookupFn;
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
		const encoded = cleaned.split("''").slice(1).join("''") || cleaned;
		try {
			return getBasename(decodeURIComponent(encoded));
		} catch {
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
		const text = await res.text();
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
		return `${collapsed.slice(0, maxChars)}…`;
	} catch {
		return undefined;
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
		});
	} catch (err) {
		throw new MediaFetchError(
			"fetch_failed",
			`Failed to fetch media from ${options.url}: ${String(err)}`,
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
	if (!maxBytes || !contentLength) {
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
		enforceContentLengthLimit(res, options.url, options.maxBytes);

		const buffer = options.maxBytes
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
		await release();
	}
}

async function readResponseWithLimit(
	res: Response,
	maxBytes: number,
): Promise<Buffer> {
	const body = res.body;
	if (!body || typeof body.getReader !== "function") {
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
			if (value?.length) {
				total += value.length;
				if (total > maxBytes) {
					try {
						await reader.cancel();
					} catch {
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
			// ignore release errors
		}
	}

	return Buffer.concat(
		chunks.map((chunk) => Buffer.from(chunk)),
		total,
	);
}
