/**
 * Sandbox fetch proxy. Detokenizes outbound requests, sanitizes inbound responses.
 */

import {
	SANDBOX_TOKEN_PREFIX,
	type SandboxTokenManager,
} from "../security/sandbox-token-manager.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SandboxFetchProxyOptions {
	/** The token manager holding token↔secret mappings. */
	tokenManager: SandboxTokenManager;

	/** Base fetch to delegate to after detokenization. Defaults to globalThis.fetch. */
	baseFetch?: typeof fetch;

	onAuditEvent?: (event: SandboxFetchAuditEvent) => void;
	/** "fail-closed" = throw on error; "fail-open" = proceed without replacement. */
	failureMode?: "fail-closed" | "fail-open";
	/** Max response body size to scan (default 10MB). */
	maxResponseScanBytes?: number;
}

export interface SandboxFetchAuditEvent {
	timestamp: number;
	direction: "outbound" | "inbound";
	url: string;
	replacementCount: number;
	tokenIds: string[];
	error?: string;
}

const DEFAULT_MAX_RESPONSE_SCAN_BYTES = 10 * 1024 * 1024;
type FetchPreconnect = (
	url: string | URL,
	options?: {
		dns?: boolean;
		tcp?: boolean;
		http?: boolean;
		https?: boolean;
	},
) => void;
type FetchWithOptionalPreconnect = typeof fetch & {
	preconnect?: FetchPreconnect;
};

const TEXT_CONTENT_TYPES = [
	"text/",
	"application/json",
	"application/xml",
	"application/x-www-form-urlencoded",
	"application/javascript",
	"application/ld+json",
	"application/graphql",
	"application/xhtml+xml",
	"application/soap+xml",
];

export function createSandboxFetchProxy(
	options: SandboxFetchProxyOptions,
): typeof fetch {
	const {
		tokenManager,
		baseFetch = globalThis.fetch,
		onAuditEvent,
		failureMode = "fail-closed",
		maxResponseScanBytes = DEFAULT_MAX_RESPONSE_SCAN_BYTES,
	} = options;
	const baseFetchWithExtensions = baseFetch as FetchWithOptionalPreconnect;
	const preconnect: FetchPreconnect = (url, preconnectOptions): void => {
		if (typeof baseFetchWithExtensions.preconnect === "function") {
			baseFetchWithExtensions.preconnect(url, preconnectOptions);
		}
	};

	const proxy = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			// Detokenize outbound
			let detokenizedInput = input;
			let detokenizedInit = init;
			const outboundTokenIds: string[] = [];

			try {
				const result = detokenizeRequest(tokenManager, input, init);
				detokenizedInput = result.input;
				detokenizedInit = result.init;
				outboundTokenIds.push(...result.replacedTokenIds);
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				onAuditEvent?.({
					timestamp: Date.now(),
					direction: "outbound",
					url: extractUrl(input),
					replacementCount: 0,
					tokenIds: [],
					error: errorMsg,
				});
				if (failureMode === "fail-closed") {
					throw new Error(
						`Sandbox fetch proxy: outbound detokenization failed: ${errorMsg}`,
					);
				}
				// fail-open: proceed with original request
			}

			if (outboundTokenIds.length > 0) {
				onAuditEvent?.({
					timestamp: Date.now(),
					direction: "outbound",
					url: extractUrl(detokenizedInput),
					replacementCount: outboundTokenIds.length,
					tokenIds: outboundTokenIds,
				});
			}

			// Execute
			const response = await baseFetch(detokenizedInput, detokenizedInit);

			// Sanitize inbound
			const sanitized = await tokenizeResponse(
				tokenManager,
				response,
				maxResponseScanBytes,
				onAuditEvent,
				failureMode,
				extractUrl(detokenizedInput),
			);

			return sanitized;
		},
		{ preconnect },
	) satisfies typeof fetch;

	return proxy;
}

interface DetokenizeResult {
	input: RequestInfo | URL;
	init: RequestInit | undefined;
	replacedTokenIds: string[];
}

function detokenizeRequest(
	tm: SandboxTokenManager,
	input: RequestInfo | URL,
	init: RequestInit | undefined,
): DetokenizeResult {
	const replacedTokenIds: string[] = [];

	// Handle Request objects
	let effectiveInput: RequestInfo | URL = input;
	let effectiveInit = init;

	if (typeof input === "object" && "url" in input && input instanceof Request) {
		// Extract Request headers into init
		const requestHeaders: Record<string, string> = {};
		input.headers.forEach((value, key) => {
			requestHeaders[key] = value;
		});

		effectiveInput = input.url;
		effectiveInit = {
			method: input.method,
			headers: { ...requestHeaders, ...headersToRecord(init?.headers ?? {}) },
			body: init?.body ?? null,
			signal: init?.signal ?? input.signal,
			redirect: init?.redirect ?? input.redirect,
			...init,
			// Ensure merged headers take precedence
			...(Object.keys(requestHeaders).length > 0
				? {
						headers: {
							...requestHeaders,
							...headersToRecord(init?.headers ?? {}),
						},
					}
				: {}),
		};
	}

	// -- URL --
	let resolvedInput: RequestInfo | URL = effectiveInput;
	const urlStr = extractUrl(effectiveInput);
	if (urlStr.includes(SANDBOX_TOKEN_PREFIX)) {
		const detokenized = tm.detokenizeString(urlStr);
		if (detokenized !== urlStr) {
			collectReplacedTokens(urlStr, tm, replacedTokenIds);
			resolvedInput = detokenized;
		}
	}

	if (!effectiveInit) {
		return { input: resolvedInput, init: effectiveInit, replacedTokenIds };
	}

	// -- Headers --
	let resolvedHeaders = effectiveInit.headers;
	if (effectiveInit.headers) {
		const headerObj = headersToRecord(effectiveInit.headers);
		let headersChanged = false;

		for (const [key, value] of Object.entries(headerObj)) {
			if (typeof value === "string" && value.includes(SANDBOX_TOKEN_PREFIX)) {
				const detokenized = tm.detokenizeString(value);
				if (detokenized !== value) {
					collectReplacedTokens(value, tm, replacedTokenIds);
					headerObj[key] = detokenized;
					headersChanged = true;
				}
			}
		}

		if (headersChanged) {
			resolvedHeaders = headerObj;
		}
	}

	// -- Body --
	let resolvedBody = effectiveInit.body;
	if (effectiveInit.body && typeof effectiveInit.body === "string") {
		if (effectiveInit.body.includes(SANDBOX_TOKEN_PREFIX)) {
			const detokenized = tm.detokenizeString(effectiveInit.body);
			if (detokenized !== effectiveInit.body) {
				collectReplacedTokens(effectiveInit.body, tm, replacedTokenIds);
				resolvedBody = detokenized;
			}
		}
	}

	const resolvedInit: RequestInit = {
		...effectiveInit,
		headers: resolvedHeaders,
		body: resolvedBody,
	};

	return { input: resolvedInput, init: resolvedInit, replacedTokenIds };
}

async function tokenizeResponse(
	tm: SandboxTokenManager,
	response: Response,
	maxScanBytes: number,
	onAuditEvent?: (event: SandboxFetchAuditEvent) => void,
	failureMode: "fail-closed" | "fail-open" = "fail-open",
	requestUrl?: string,
): Promise<Response> {
	const responseUrl = requestUrl || response.url || "(unknown)";

	const handleInboundError = (message: string): Response => {
		onAuditEvent?.({
			timestamp: Date.now(),
			direction: "inbound",
			url: responseUrl,
			replacementCount: 0,
			tokenIds: [],
			error: message,
		});
		if (failureMode === "fail-closed") {
			throw new Error(
				`Sandbox fetch proxy: inbound sanitization failed: ${message}`,
			);
		}
		return response;
	};

	// Skip if token manager has no secrets registered
	if (tm.size === 0) {
		return response;
	}

	const contentType = response.headers.get("content-type") || "";
	const isTextLike = TEXT_CONTENT_TYPES.some((prefix) =>
		contentType.toLowerCase().includes(prefix),
	);

	if (!isTextLike) {
		return response; // Don't scan binary responses
	}

	const contentLength = response.headers.get("content-length");
	if (contentLength && parseInt(contentLength, 10) > maxScanBytes) {
		return response; // Too large to scan
	}

	// Clone the response before reading the body to avoid consuming it.
	// If the body was already consumed, clone() will throw — in that case
	// we cannot sanitize and must return the original.
	let clonedResponse: Response;
	try {
		clonedResponse = response.clone();
	} catch (error) {
		const errorMsg =
			error instanceof Error
				? `response clone failed (${error.message})`
				: "response clone failed";
		return handleInboundError(errorMsg);
	}

	// Read body with timeout to prevent hanging on slow/large responses
	let bodyText: string;
	try {
		const BODY_READ_TIMEOUT_MS = 10_000;
		bodyText = await Promise.race([
			clonedResponse.text(),
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error("body read timeout")),
					BODY_READ_TIMEOUT_MS,
				),
			),
		]);
	} catch (error) {
		const errorMsg =
			error instanceof Error
				? `response read failed (${error.message})`
				: "response read failed";
		return handleInboundError(errorMsg);
	}

	if (bodyText.length > maxScanBytes) {
		// Rebuild response with original body
		return new Response(bodyText, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}

	const sanitized = tm.tokenizeString(bodyText);

	if (sanitized !== bodyText) {
		// Count replacements (approximate by checking token prefix occurrences diff)
		const tokenIds = collectTokensInString(sanitized, tm);
		onAuditEvent?.({
			timestamp: Date.now(),
			direction: "inbound",
			url: response.url,
			replacementCount: tokenIds.length,
			tokenIds,
		});
	}

	// Sanitize selected response headers
	const newHeaders = new Headers(response.headers);
	for (const headerName of ["set-cookie", "location", "www-authenticate"]) {
		const headerValue = newHeaders.get(headerName);
		if (headerValue) {
			const sanitizedHeader = tm.tokenizeString(headerValue);
			if (sanitizedHeader !== headerValue) {
				newHeaders.set(headerName, sanitizedHeader);
			}
		}
	}

	return new Response(sanitized, {
		status: response.status,
		statusText: response.statusText,
		headers: newHeaders,
	});
}

function extractUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	return String(input);
}

function headersToRecord(headers: HeadersInit): Record<string, string> {
	if (headers instanceof Headers) {
		const record: Record<string, string> = {};
		headers.forEach((value, key) => {
			record[key] = value;
		});
		return record;
	}
	if (Array.isArray(headers)) {
		const record: Record<string, string> = {};
		for (const [key, value] of headers) {
			record[key] = value;
		}
		return record;
	}
	// Already a record
	return { ...(headers as Record<string, string>) };
}

function collectReplacedTokens(
	str: string,
	tm: SandboxTokenManager,
	out: string[],
): void {
	const regex = new RegExp(
		`${escapeRegex(SANDBOX_TOKEN_PREFIX)}[0-9a-f-]{36}`,
		"g",
	);
	let match: RegExpExecArray | null = regex.exec(str);
	while (match !== null) {
		const token = match[0];
		if (tm.resolveToken(token) !== null && !out.includes(token)) {
			out.push(token);
		}
		match = regex.exec(str);
	}
}

function collectTokensInString(str: string, tm: SandboxTokenManager): string[] {
	const tokens: string[] = [];
	const regex = new RegExp(
		`${escapeRegex(SANDBOX_TOKEN_PREFIX)}[0-9a-f-]{36}`,
		"g",
	);
	let match: RegExpExecArray | null = regex.exec(str);
	while (match !== null) {
		const token = match[0];
		if (tm.getMetadata(token) !== null && !tokens.includes(token)) {
			tokens.push(token);
		}
		match = regex.exec(str);
	}
	return tokens;
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
