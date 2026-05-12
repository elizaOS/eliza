import { isLoopbackBindHost, isWildcardBindHost } from "@elizaos/shared";

function isExternalPlainHttpUrl(parsed: URL): boolean {
	return (
		parsed.protocol === "http:" &&
		!isLoopbackBindHost(parsed.hostname) &&
		!isWildcardBindHost(parsed.hostname)
	);
}

export function normalizeDesktopHttpRequest(params: unknown): {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string | null;
	timeoutMs?: number;
} {
	if (!params || typeof params !== "object") {
		throw new Error("desktopHttpRequest params must be an object.");
	}
	const record = params as Record<string, unknown>;
	if (typeof record.url !== "string") {
		throw new Error("desktopHttpRequest url must be a string.");
	}
	const parsed = new URL(record.url);
	if (!isExternalPlainHttpUrl(parsed)) {
		throw new Error(
			"desktopHttpRequest supports only external plain HTTP URLs.",
		);
	}
	const method = typeof record.method === "string" ? record.method : "GET";
	const headers =
		record.headers && typeof record.headers === "object"
			? Object.fromEntries(
					Object.entries(record.headers as Record<string, unknown>)
						.filter((entry): entry is [string, string] => {
							return typeof entry[1] === "string";
						})
						.map(([key, value]) => [key, value]),
				)
			: {};
	const body = typeof record.body === "string" ? record.body : null;
	const timeoutMs =
		typeof record.timeoutMs === "number" &&
		Number.isFinite(record.timeoutMs) &&
		record.timeoutMs > 0
			? record.timeoutMs
			: undefined;
	return { url: parsed.toString(), method, headers, body, timeoutMs };
}

function responseHeadersToRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	headers.forEach((value, key) => {
		record[key] = value;
	});
	return record;
}

export async function desktopHttpRequest(params: unknown): Promise<{
	status: number;
	statusText?: string;
	headers?: Record<string, string>;
	body?: string | null;
}> {
	const request = normalizeDesktopHttpRequest(params);
	const abortController = new AbortController();
	const operation = (async () => {
		const response = await fetch(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body,
			signal: abortController.signal,
		});
		const body = await response.text();
		return {
			status: response.status,
			statusText: response.statusText,
			headers: responseHeadersToRecord(response.headers),
			body,
		};
	})();

	if (!request.timeoutMs) {
		return operation;
	}

	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			abortController.abort();
			reject(
				new Error(`desktopHttpRequest timed out after ${request.timeoutMs}ms.`),
			);
		}, request.timeoutMs);
	});

	try {
		return await Promise.race([operation, timeout]);
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
	}
}
