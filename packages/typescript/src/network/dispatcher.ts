/**
 * Undici dispatcher utilities for DNS pinning in Node.js.
 *
 * Provides Node.js-specific fetch enhancements using undici dispatchers
 * for true DNS pinning (not available in browser environments).
 *
 * @module network/dispatcher
 */

import { Agent, type Dispatcher } from "undici";
import {
	type LookupFn,
	type PinnedHostname,
	resolvePinnedHostname,
	resolvePinnedHostnameWithPolicy,
	type SsrfPolicy,
} from "./ssrf.js";

/**
 * Create an undici dispatcher with pinned DNS lookup.
 *
 * This ensures all requests through this dispatcher use the pre-resolved
 * IP addresses, preventing DNS rebinding attacks.
 *
 * @param pinned - Pre-resolved hostname information
 * @returns Undici dispatcher
 */
export function createPinnedDispatcher(pinned: PinnedHostname): Dispatcher {
	return new Agent({
		connect: {
			lookup: pinned.lookup,
		},
	});
}

/**
 * Close an undici dispatcher.
 *
 * @param dispatcher - Dispatcher to close
 */
export async function closeDispatcher(
	dispatcher?: Dispatcher | null,
): Promise<void> {
	if (!dispatcher) {
		return;
	}
	const candidate = dispatcher as {
		close?: () => Promise<void> | void;
		destroy?: () => void;
	};
	try {
		if (typeof candidate.close === "function") {
			await candidate.close();
			return;
		}
		if (typeof candidate.destroy === "function") {
			candidate.destroy();
		}
	} catch {
		// ignore dispatcher cleanup errors
	}
}

/**
 * Options for fetch with DNS pinning.
 */
export type PinnedFetchOptions = {
	/** URL to fetch */
	url: string;
	/** Fetch implementation to use */
	fetchImpl?: (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => Promise<Response>;
	/** Request init options */
	init?: RequestInit;
	/** Maximum number of redirects to follow */
	maxRedirects?: number;
	/** Timeout in milliseconds */
	timeoutMs?: number;
	/** Abort signal */
	signal?: AbortSignal;
	/** SSRF policy configuration */
	policy?: SsrfPolicy;
	/** Custom DNS lookup function */
	lookupFn?: LookupFn;
	/** Whether to use DNS pinning (default: true) */
	pinDns?: boolean;
};

/**
 * Result from a pinned fetch operation.
 */
export type PinnedFetchResult = {
	/** The response object */
	response: Response;
	/** Final URL after redirects */
	finalUrl: string;
	/** Release function to cleanup dispatcher */
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
 * Fetch with SSRF protection and undici DNS pinning.
 *
 * This is the Node.js-specific version that uses undici dispatchers
 * for true DNS pinning, preventing DNS rebinding attacks.
 *
 * @example
 * ```ts
 * const { response, release } = await fetchWithPinnedDns({
 *   url: 'https://api.example.com/data',
 *   timeoutMs: 30000,
 * });
 * try {
 *   const data = await response.json();
 *   // use data
 * } finally {
 *   await release();
 * }
 * ```
 */
export async function fetchWithPinnedDns(
	params: PinnedFetchOptions,
): Promise<PinnedFetchResult> {
	const fetcher = params.fetchImpl ?? globalThis.fetch;
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
	const release = async (dispatcher?: Dispatcher | null) => {
		if (released) {
			return;
		}
		released = true;
		cleanup();
		await closeDispatcher(dispatcher ?? undefined);
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

		let dispatcher: Dispatcher | null = null;
		try {
			const usePolicy = Boolean(
				params.policy?.allowPrivateNetwork ||
					params.policy?.allowedHostnames?.length,
			);
			const pinned = usePolicy
				? await resolvePinnedHostnameWithPolicy(parsedUrl.hostname, {
						lookupFn: params.lookupFn,
						policy: params.policy,
					})
				: await resolvePinnedHostname(parsedUrl.hostname, params.lookupFn);
			if (params.pinDns !== false) {
				dispatcher = createPinnedDispatcher(pinned);
			}

			const init: RequestInit & { dispatcher?: Dispatcher } = {
				...(params.init ? { ...params.init } : {}),
				redirect: "manual",
				...(dispatcher ? { dispatcher } : {}),
				...(signal ? { signal } : {}),
			};

			const response = await fetcher(parsedUrl.toString(), init);

			if (isRedirectStatus(response.status)) {
				const location = response.headers.get("location");
				if (!location) {
					await release(dispatcher);
					throw new Error(
						`Redirect missing location header (${response.status})`,
					);
				}
				redirectCount += 1;
				if (redirectCount > maxRedirects) {
					await release(dispatcher);
					throw new Error(`Too many redirects (limit: ${maxRedirects})`);
				}
				const nextUrl = new URL(location, parsedUrl).toString();
				if (visited.has(nextUrl)) {
					await release(dispatcher);
					throw new Error("Redirect loop detected");
				}
				visited.add(nextUrl);
				void response.body?.cancel();
				await closeDispatcher(dispatcher);
				currentUrl = nextUrl;
				continue;
			}

			return {
				response,
				finalUrl: currentUrl,
				release: async () => release(dispatcher),
			};
		} catch (err) {
			await release(dispatcher);
			throw err;
		}
	}
}
