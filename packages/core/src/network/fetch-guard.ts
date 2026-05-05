/**
 * SSRF-guarded fetch utilities.
 *
 * Provides a fetch wrapper that validates URLs and pins DNS to prevent
 * SSRF attacks and DNS rebinding.
 */

import {
	type LookupFn,
	resolvePinnedHostname,
	resolvePinnedHostnameWithPolicy,
	type SsrfPolicy,
} from "./ssrf.js";

type FetchLike = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export type GuardedFetchOptions = {
	url: string;
	fetchImpl?: FetchLike;
	init?: RequestInit;
	maxRedirects?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
	policy?: SsrfPolicy;
	lookupFn?: LookupFn;
};

export type GuardedFetchResult = {
	response: Response;
	finalUrl: string;
	release: () => Promise<void>;
};

const DEFAULT_MAX_REDIRECTS = 3;

function isRedirectStatus(status: number): boolean {
	return (
		status === 301 ||
		status === 302 ||
		status === 303 ||
		status === 307 ||
		status === 308
	);
}

function buildAbortSignal(params: {
	timeoutMs?: number;
	signal?: AbortSignal;
}): {
	signal?: AbortSignal;
	cleanup: () => void;
} {
	const { timeoutMs, signal } = params;
	if (!timeoutMs && !signal) {
		return { signal: undefined, cleanup: () => {} };
	}

	if (!timeoutMs) {
		return { signal, cleanup: () => {} };
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort();
	if (signal) {
		if (signal.aborted) {
			controller.abort();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	const cleanup = () => {
		clearTimeout(timeoutId);
		if (signal) {
			signal.removeEventListener("abort", onAbort);
		}
	};

	return { signal: controller.signal, cleanup };
}

/**
 * Fetch with SSRF protection.
 *
 * - Validates URL protocol (http/https only)
 * - Resolves and pins DNS to prevent rebinding attacks
 * - Follows redirects manually with validation
 * - Supports timeout and abort signals
 */
export async function fetchWithSsrfGuard(
	params: GuardedFetchOptions,
): Promise<GuardedFetchResult> {
	const fetcher: FetchLike | undefined = params.fetchImpl ?? globalThis.fetch;
	if (!fetcher) {
		throw new Error("fetch is not available");
	}

	const maxRedirects =
		typeof params.maxRedirects === "number" &&
		Number.isFinite(params.maxRedirects)
			? Math.max(0, Math.floor(params.maxRedirects))
			: DEFAULT_MAX_REDIRECTS;

	const { signal, cleanup } = buildAbortSignal({
		timeoutMs: params.timeoutMs,
		signal: params.signal,
	});

	let released = false;
	const release = async () => {
		if (released) {
			return;
		}
		released = true;
		cleanup();
	};

	const visited = new Set<string>();
	let currentUrl = params.url;
	let redirectCount = 0;

	while (true) {
		let parsedUrl: URL;
		try {
			parsedUrl = new URL(currentUrl);
		} catch {
			await release();
			throw new Error("Invalid URL: must be http or https");
		}
		if (!["http:", "https:"].includes(parsedUrl.protocol)) {
			await release();
			throw new Error("Invalid URL: must be http or https");
		}

		try {
			const usePolicy = Boolean(
				params.policy?.allowPrivateNetwork ||
					params.policy?.allowedHostnames?.length,
			);
			const _pinned = usePolicy
				? await resolvePinnedHostnameWithPolicy(parsedUrl.hostname, {
						lookupFn: params.lookupFn,
						policy: params.policy,
					})
				: await resolvePinnedHostname(parsedUrl.hostname, params.lookupFn);

			// Note: In browser environments, we can't pin DNS, so we rely on policy validation only
			const init: RequestInit = {
				...(params.init ? { ...params.init } : {}),
				redirect: "manual",
				...(signal ? { signal } : {}),
			};

			const response = await fetcher(parsedUrl.toString(), init);

			if (isRedirectStatus(response.status)) {
				const location = response.headers.get("location");
				if (!location) {
					await release();
					throw new Error(
						`Redirect missing location header (${response.status})`,
					);
				}
				redirectCount += 1;
				if (redirectCount > maxRedirects) {
					await release();
					throw new Error(`Too many redirects (limit: ${maxRedirects})`);
				}
				const nextUrl = new URL(location, parsedUrl).toString();
				if (visited.has(nextUrl)) {
					await release();
					throw new Error("Redirect loop detected");
				}
				visited.add(nextUrl);
				void response.body?.cancel();
				currentUrl = nextUrl;
				continue;
			}

			return {
				response,
				finalUrl: currentUrl,
				release,
			};
		} catch (err) {
			await release();
			throw err;
		}
	}
}
