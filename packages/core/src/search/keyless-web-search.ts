/**
 * Bounded keyless web search shared by Node and Workerd Eliza runtimes. The
 * provider endpoints are fixed, redirects are refused, response bodies are
 * capped while streaming, and Parallel failures fall through to Exa without
 * exposing query text in logs or errors.
 */

const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const DEFAULT_RESULT_COUNT = 6;
const MAX_RESULT_COUNT = 10;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RESPONSE_BYTES = 256 * 1024;

export type KeylessWebSearchProvider = "parallel" | "exa";
export type KeylessWebSearchFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export interface KeylessWebSearchOptions {
	resultCount?: number;
	timeoutMs?: number;
	maxResponseBytes?: number;
	/** @deprecated Search results are always returned in full. */
	maxResultChars?: number;
	fetchImpl?: KeylessWebSearchFetch;
}

export interface KeylessWebSearchResult {
	provider: KeylessWebSearchProvider;
	text: string;
	truncated: boolean;
}

function parseMcpResultText(body: string): string | undefined {
	const parsePayload = (payload: string): string | undefined => {
		const trimmed = payload.trim();
		if (!trimmed.startsWith("{")) return undefined;
		try {
			const data = JSON.parse(trimmed) as {
				error?: unknown;
				result?: { isError?: boolean; content?: Array<{ text?: string }> };
			};
			if (data.error || data.result?.isError) return undefined;
			const text = data.result?.content?.find((item) => item.text)?.text;
			return text?.trim() ? text : undefined;
		} catch {
			// error-policy:J3 MCP payloads are untrusted and invalid envelopes are explicit misses.
			return undefined;
		}
	};

	const direct = parsePayload(body);
	if (direct) return direct;
	for (const line of body.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const parsed = parsePayload(line.slice(6));
		if (parsed) return parsed;
	}
	return undefined;
}

async function readTextCapped(
	response: Response,
	maxBytes: number,
): Promise<string | undefined> {
	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	if (
		contentType &&
		!contentType.startsWith("text/") &&
		!contentType.includes("application/json") &&
		!contentType.includes("text/event-stream")
	) {
		await response.body?.cancel();
		return undefined;
	}
	if (!response.body) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (bytes + value.byteLength > maxBytes) {
				await reader.cancel("keyless web search response exceeded byte limit");
				return undefined;
			}
			bytes += value.byteLength;
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

async function callMcp(
	url: string,
	toolName: string,
	args: Record<string, unknown>,
	options: Required<
		Pick<
			KeylessWebSearchOptions,
			"timeoutMs" | "maxResponseBytes" | "fetchImpl"
		>
	>,
): Promise<string | undefined> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
	try {
		const response = await options.fetchImpl(url, {
			method: "POST",
			redirect: "manual",
			signal: controller.signal,
			headers: {
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: toolName, arguments: args },
			}),
		});
		if (!response.ok) {
			await response.body?.cancel();
			return undefined;
		}
		const body = await readTextCapped(response, options.maxResponseBytes);
		return body === undefined ? undefined : parseMcpResultText(body);
	} catch {
		// error-policy:J1 This provider boundary returns a miss so the caller can try the declared fallback.
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

export async function searchKeylessWeb(
	query: string,
	options: KeylessWebSearchOptions = {},
): Promise<KeylessWebSearchResult | undefined> {
	const normalizedQuery = query.trim();
	if (!normalizedQuery) throw new Error("Web search query is required");

	const resultCount = Math.min(
		MAX_RESULT_COUNT,
		Math.max(1, Math.floor(options.resultCount ?? DEFAULT_RESULT_COUNT)),
	);
	const transport = {
		fetchImpl:
			options.fetchImpl ??
			((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)),
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		maxResponseBytes: options.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES,
	};

	let provider: KeylessWebSearchProvider = "parallel";
	let text = await callMcp(
		PARALLEL_MCP_URL,
		"web_search",
		{ objective: normalizedQuery, search_queries: [normalizedQuery] },
		transport,
	);
	if (!text) {
		provider = "exa";
		text = await callMcp(
			EXA_MCP_URL,
			"web_search_exa",
			{
				query: normalizedQuery,
				type: "auto",
				numResults: resultCount,
				livecrawl: "fallback",
			},
			transport,
		);
	}
	if (!text) return undefined;

	void options.maxResultChars;
	return {
		provider,
		text,
		truncated: false,
	};
}
