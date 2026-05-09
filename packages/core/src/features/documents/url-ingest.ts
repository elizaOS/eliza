import { Buffer } from "node:buffer";
import { lookup as dnsLookup } from "node:dns/promises";
import {
	type RequestOptions as HttpRequestOptions,
	type IncomingMessage,
	request as requestHttp,
} from "node:http";
import { request as requestHttps } from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import { createPinnedLookup } from "../../network/ssrf.ts";

const MAX_URL_IMPORT_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_YOUTUBE_WATCH_PAGE_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_YOUTUBE_TRANSCRIPT_BYTES = 10 * 1024 * 1024; // 10 MB
const URL_FETCH_TIMEOUT_MS = 15_000;
const BLOCKED_HOST_LITERALS = new Set([
	"localhost",
	"metadata.google.internal",
]);

const ALWAYS_BLOCKED_IP_PATTERNS: RegExp[] = [
	/^0\./, // "this" network
	/^169\.254\./, // link-local / metadata
	/^fe[89ab][0-9a-f]:/i, // IPv6 link-local fe80::/10
	/^::$/i, // unspecified
	/^::1$/i, // IPv6 loopback
];

const PRIVATE_IP_PATTERNS: RegExp[] = [
	/^10\./, // RFC1918
	/^127\./, // loopback
	/^172\.(1[6-9]|2\d|3[01])\./, // RFC1918
	/^192\.168\./, // RFC1918
	/^f[cd][0-9a-f]{2}:/i, // IPv6 ULA fc00::/7
];

function normalizeHostLike(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "");
}

function decodeIpv6MappedHex(mapped: string): string | null {
	const parts = mapped.split(":");
	if (parts.length < 1 || parts.length > 2) return null;

	const parsed = parts.map((part) => {
		if (!/^[0-9a-f]{1,4}$/i.test(part)) return Number.NaN;
		return Number.parseInt(part, 16);
	});
	if (parsed.some((value) => !Number.isFinite(value))) return null;

	const [hi, lo] = parsed.length === 1 ? [0, parsed[0]] : parsed;
	const octets = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
	return octets.join(".");
}

function canonicalizeIpv6(ip: string): string | null {
	try {
		return new URL(`http://[${ip}]/`).hostname.replace(/^\[|\]$/g, "");
	} catch {
		return null;
	}
}

function normalizeIpForPolicy(ip: string): string {
	const base = normalizeHostLike(ip).split("%")[0];
	if (!base) return base;

	let normalized = base;
	if (net.isIP(normalized) === 6) {
		normalized = canonicalizeIpv6(normalized) ?? normalized;
	}

	let mapped: string | null = null;
	if (normalized.startsWith("::ffff:")) {
		mapped = normalized.slice("::ffff:".length);
	} else if (normalized.startsWith("0:0:0:0:0:ffff:")) {
		mapped = normalized.slice("0:0:0:0:0:ffff:".length);
	}
	if (!mapped) return normalized;

	if (net.isIP(mapped) === 4) return mapped;
	return decodeIpv6MappedHex(mapped) ?? normalized;
}

function isBlockedPrivateOrLinkLocalIp(ip: string): boolean {
	const normalized = normalizeIpForPolicy(ip);
	if (ALWAYS_BLOCKED_IP_PATTERNS.some((pattern) => pattern.test(normalized))) {
		return true;
	}
	return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(normalized));
}

type ResolvedUrlTarget = {
	parsed: URL;
	hostname: string;
	pinnedAddress: string;
};

type PinnedFetchInput = {
	url: URL;
	init: RequestInit;
	target: ResolvedUrlTarget;
	timeoutMs: number;
};

type PinnedFetchImpl = (input: PinnedFetchInput) => Promise<Response>;

function toRequestHeaders(headers: Headers): Record<string, string> {
	const normalized: Record<string, string> = {};
	headers.forEach((value, key) => {
		normalized[key] = value;
	});
	return normalized;
}

/** Node's `Readable.toWeb` stream is valid `fetch` `BodyInit`; lib.dom and `node:stream/web` disagree in TypeScript. */
function incomingMessageToWebBody(stream: IncomingMessage): BodyInit {
	const webStream = Readable.toWeb(stream);
	// @ts-expect-error Node stream/web ReadableStream is accepted by Response; DOM vs Node declarations diverge.
	return webStream;
}

function responseFromIncomingMessage(response: IncomingMessage): Response {
	const headers = new Headers();
	for (const [key, value] of Object.entries(response.headers)) {
		if (Array.isArray(value)) {
			for (const item of value) headers.append(key, item);
		} else if (typeof value === "string") {
			headers.set(key, value);
		}
	}

	const status = response.statusCode ?? 500;
	const init = {
		status,
		statusText: response.statusMessage,
		headers,
	} satisfies ResponseInit;
	if (status === 204 || status === 205 || status === 304) {
		return new Response(null, init);
	}
	return new Response(incomingMessageToWebBody(response), init);
}

async function requestWithPinnedAddress(
	input: PinnedFetchInput,
): Promise<Response> {
	const { url, init, target, timeoutMs } = input;

	if (init.body !== undefined && init.body !== null) {
		throw new Error("URL fetch request body is not supported");
	}

	const method = (init.method ?? "GET").toUpperCase();
	const headers = toRequestHeaders(new Headers(init.headers));
	const requestFn = url.protocol === "https:" ? requestHttps : requestHttp;
	return await new Promise<Response>((resolve, reject) => {
		let settled = false;
		const signal = init.signal;
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle !== null) clearTimeout(timeoutHandle);
			signal?.removeEventListener("abort", onAbort);
			callback();
		};

		const onAbort = () => {
			request.destroy(new DOMException("Aborted", "AbortError"));
		};

		const requestOptions: HttpRequestOptions = {
			protocol: url.protocol,
			hostname: target.hostname,
			port: url.port ? Number(url.port) : undefined,
			method,
			path: `${url.pathname}${url.search}`,
			headers,
			lookup: createPinnedLookup({
				hostname: target.hostname,
				addresses: [target.pinnedAddress],
			}) as HttpRequestOptions["lookup"],
			...(url.protocol === "https:"
				? { servername: target.hostname }
				: undefined),
		};

		const request = requestFn(requestOptions, (response) => {
			settle(() => resolve(responseFromIncomingMessage(response)));
		});

		request.on("error", (error) => {
			settle(() => reject(error));
		});

		if (signal) {
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		timeoutHandle = setTimeout(() => {
			request.destroy(new Error(`URL fetch timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		request.end();
	});
}

let pinnedFetchImpl: PinnedFetchImpl = requestWithPinnedAddress;

// Test hook for deterministic network simulation without sockets.
export function __setDocumentUrlFetchImplForTests(
	impl: PinnedFetchImpl | null,
): void {
	pinnedFetchImpl = impl ?? requestWithPinnedAddress;
}

async function resolveSafeUrlTarget(url: string): Promise<{
	rejection: string | null;
	target: ResolvedUrlTarget | null;
}> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { rejection: "Invalid URL format", target: null };
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return {
			rejection: "Only http:// and https:// URLs are allowed",
			target: null,
		};
	}

	const hostname = normalizeHostLike(parsed.hostname);
	if (!hostname) return { rejection: "URL hostname is required", target: null };

	if (BLOCKED_HOST_LITERALS.has(hostname)) {
		return {
			rejection: `URL host "${hostname}" is blocked for security reasons`,
			target: null,
		};
	}

	if (net.isIP(hostname)) {
		if (isBlockedPrivateOrLinkLocalIp(hostname)) {
			return {
				rejection: `URL host "${hostname}" is blocked for security reasons`,
				target: null,
			};
		}
		return {
			rejection: null,
			target: {
				parsed,
				hostname,
				pinnedAddress: hostname,
			},
		};
	}

	let addresses: Array<{ address: string }>;
	try {
		const resolved = await dnsLookup(hostname, { all: true });
		addresses = Array.isArray(resolved) ? resolved : [resolved];
	} catch {
		return {
			rejection: `Could not resolve URL host "${hostname}"`,
			target: null,
		};
	}

	if (addresses.length === 0) {
		return {
			rejection: `Could not resolve URL host "${hostname}"`,
			target: null,
		};
	}
	for (const entry of addresses) {
		if (isBlockedPrivateOrLinkLocalIp(entry.address)) {
			return {
				rejection: `URL host "${hostname}" resolves to blocked address ${entry.address}`,
				target: null,
			};
		}
	}

	return {
		rejection: null,
		target: {
			parsed,
			hostname,
			pinnedAddress: addresses[0]?.address ?? "",
		},
	};
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException
		? error.name === "AbortError"
		: error instanceof Error && error.name === "AbortError";
}

async function fetchWithSafety(
	url: string,
	init: RequestInit,
	timeoutMs = URL_FETCH_TIMEOUT_MS,
): Promise<Response> {
	const { rejection, target } = await resolveSafeUrlTarget(url);
	if (rejection || !target || !target.pinnedAddress) {
		throw new Error(rejection ?? "URL validation failed");
	}

	try {
		return await pinnedFetchImpl({
			url: target.parsed,
			init,
			target,
			timeoutMs,
		});
	} catch (error) {
		if (isAbortError(error)) {
			throw new Error(`URL fetch timed out after ${timeoutMs}ms`);
		}
		throw error;
	}
}

function readContentLengthHeader(response: Response): number | null {
	const raw = response.headers.get("content-length");
	if (!raw) return null;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return null;
	return parsed;
}

async function readResponseBodyWithLimit(
	response: Response,
	maxBytes: number,
): Promise<Uint8Array> {
	const declaredLength = readContentLengthHeader(response);
	if (declaredLength !== null && declaredLength > maxBytes) {
		throw new Error(`URL content exceeds maximum size of ${maxBytes} bytes`);
	}

	if (!response.body) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > maxBytes) {
			throw new Error(`URL content exceeds maximum size of ${maxBytes} bytes`);
		}
		return bytes;
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;

			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				throw new Error(
					`URL content exceeds maximum size of ${maxBytes} bytes`,
				);
			}

			chunks.push(value);
		}
	} catch (err) {
		try {
			await reader.cancel(err);
		} catch {
			// Best effort cleanup; keep the original error.
		}
		throw err;
	} finally {
		reader.releaseLock();
	}

	const output = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return output;
}

export function isYouTubeUrl(url: string): boolean {
	return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)/.test(url);
}

function extractYouTubeVideoId(url: string): string | null {
	// Handle youtu.be/VIDEO_ID
	const shortMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
	if (shortMatch) return shortMatch[1];

	// Handle youtube.com/watch?v=VIDEO_ID
	const watchMatch = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
	if (watchMatch) return watchMatch[1];

	// Handle youtube.com/embed/VIDEO_ID
	const embedMatch = url.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
	if (embedMatch) return embedMatch[1];

	// Handle youtube.com/v/VIDEO_ID
	const vMatch = url.match(/\/v\/([a-zA-Z0-9_-]{11})/);
	if (vMatch) return vMatch[1];

	return null;
}

async function fetchYouTubeTranscript(videoId: string): Promise<string | null> {
	// Fetch the video page to get transcript data
	const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
	const response = await fetchWithSafety(watchUrl, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			"Accept-Language": "en-US,en;q=0.9",
		},
	});

	if (!response.ok) {
		return null;
	}

	const html = new TextDecoder().decode(
		await readResponseBodyWithLimit(response, MAX_YOUTUBE_WATCH_PAGE_BYTES),
	);

	// Extract the captions track URL from the page
	const captionsMatch = html.match(
		/"captions":\s*\{[^}]*"playerCaptionsTracklistRenderer":\s*\{[^}]*"captionTracks":\s*\[([^\]]+)\]/,
	);
	if (!captionsMatch) {
		// Try alternative pattern for newer YouTube format
		const altMatch = html.match(/"captionTracks":\s*\[([^\]]+)\]/);
		if (!altMatch) {
			return null;
		}
	}

	// Find the base URL for English captions (or first available)
	const baseUrlMatch = html.match(
		/"baseUrl":\s*"(https:\/\/www\.youtube\.com\/api\/timedtext[^"]+)"/,
	);
	if (!baseUrlMatch) {
		return null;
	}

	// Decode the URL (it's JSON-escaped)
	const captionUrl = baseUrlMatch[1]
		.replace(/\\u0026/g, "&")
		.replace(/\\\//g, "/");

	// Fetch the transcript
	const transcriptResponse = await fetchWithSafety(captionUrl, {});
	if (!transcriptResponse.ok) {
		return null;
	}

	const transcriptXml = new TextDecoder().decode(
		await readResponseBodyWithLimit(
			transcriptResponse,
			MAX_YOUTUBE_TRANSCRIPT_BYTES,
		),
	);

	// Parse the XML transcript
	const textMatches = transcriptXml.matchAll(/<text[^>]*>([^<]*)<\/text>/g);
	const segments: string[] = [];

	for (const match of textMatches) {
		const text = decodeBasicHtmlEntities(match[1]).trim();

		if (text) {
			segments.push(text);
		}
	}

	if (segments.length === 0) {
		return null;
	}

	return segments.join(" ");
}

export type FetchedDocumentUrlKind = "text" | "transcript" | "html" | "binary";

export interface FetchedDocumentUrl {
	/** Filename derived from the URL or YouTube video id. */
	filename: string;
	/** UTF-8 string for text/transcript/html, base64 for binary. */
	content: string;
	/** Coarse classification of the fetched payload. */
	contentType: FetchedDocumentUrlKind;
	/** Underlying MIME type from the response headers (or synthesised for transcripts). */
	mimeType: string;
}

export interface FetchDocumentFromUrlOptions {
	/** Reserved: surfaced through to caller metadata when handling images. */
	includeImageDescriptions?: boolean;
}

function classifyMimeType(mimeType: string): FetchedDocumentUrlKind {
	const normalized = mimeType.toLowerCase();
	if (
		normalized.startsWith("application/pdf") ||
		normalized.startsWith("application/msword") ||
		normalized.startsWith("application/vnd.openxmlformats-officedocument") ||
		normalized.startsWith("image/")
	) {
		return "binary";
	}
	if (normalized.startsWith("text/html")) return "html";
	return "text";
}

function decodeBasicHtmlEntities(value: string): string {
	return value
		.replace(/&nbsp;/gi, " ")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/&amp;/gi, "&");
}

function htmlToPlainText(value: string): string {
	return decodeBasicHtmlEntities(
		value
			.replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
			.replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/(?:p|div|section|article|li|tr|table|h[1-6])>/gi, "\n")
			.replace(/<li\b[^>]*>/gi, "- ")
			.replace(/<[^>]+>/g, " "),
	)
		.replace(/\r/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

/**
 * Fetch a remote URL and return document-friendly content. Supports YouTube
 * transcript extraction, HTML pages, plain-text resources, and a small set of
 * binary document types (returned as base64).
 */
export async function fetchDocumentFromUrl(
	url: string,
	_opts: FetchDocumentFromUrlOptions = {},
): Promise<FetchedDocumentUrl> {
	if (isYouTubeUrl(url)) {
		const videoId = extractYouTubeVideoId(url);
		if (!videoId) {
			throw new Error("Invalid YouTube URL: could not extract video ID");
		}

		const transcript = await fetchYouTubeTranscript(videoId);
		if (!transcript) {
			throw new Error(
				"Could not fetch YouTube transcript. The video may not have captions available.",
			);
		}

		return {
			filename: `youtube-${videoId}-transcript.txt`,
			content: transcript,
			contentType: "transcript",
			mimeType: "text/plain",
		};
	}

	const response = await fetchWithSafety(url, {
		redirect: "manual",
		headers: {
			"User-Agent": "Mozilla/5.0 (compatible; Eliza/1.0; +https://elizaos.ai)",
		},
	});

	if (response.status >= 300 && response.status < 400) {
		throw new Error("URL redirects are not allowed");
	}

	if (!response.ok) {
		throw new Error(
			`Failed to fetch URL: ${response.status} ${response.statusText}`,
		);
	}

	const mimeType =
		response.headers.get("content-type") || "application/octet-stream";
	const urlObj = new URL(url);
	const pathSegments = urlObj.pathname.split("/");
	const lastSegment = pathSegments[pathSegments.length - 1] || "document";
	let filename: string;
	try {
		filename = decodeURIComponent(lastSegment);
	} catch {
		filename = lastSegment;
	}

	const buffer = await readResponseBodyWithLimit(
		response,
		MAX_URL_IMPORT_BYTES,
	);

	const kind = classifyMimeType(mimeType);

	if (kind === "binary") {
		const base64 = Buffer.from(buffer).toString("base64");
		return {
			filename,
			content: base64,
			contentType: "binary",
			mimeType,
		};
	}

	const text = new TextDecoder().decode(buffer);
	return {
		filename,
		content: kind === "html" ? htmlToPlainText(text) : text,
		contentType: kind,
		mimeType,
	};
}
