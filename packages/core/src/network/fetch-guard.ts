/**
 * SSRF-guarded fetch utilities.
 *
 * Provides a fetch wrapper that validates URLs and pins DNS to prevent
 * SSRF attacks and DNS rebinding.
 */

import { logger } from "../logger.js";
import {
	isBlockedHostname,
	isPrivateIpAddress,
	type LookupFn,
	type PinnedHostname,
	type PinnedLookup,
	resolvePinnedHostname,
	resolvePinnedHostnameWithPolicy,
	SsrfBlockedError,
	type SsrfPolicy,
} from "./ssrf.js";

type FetchLike = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export type GuardedFetchOptions = {
	url: string;
	fetchImpl?: FetchLike;
	pinnedFetchImpl?: PinnedLookupFetchLike;
	init?: RequestInit;
	maxRedirects?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
	policy?: SsrfPolicy;
	lookupFn?: LookupFn;
};

export type PinnedLookupFetchParams = {
	url: URL;
	init: RequestInit;
	lookup: PinnedLookup;
	addresses: string[];
};

export type PinnedLookupFetchLike = (
	params: PinnedLookupFetchParams,
) => Promise<Response>;

export type GuardedFetchResult = {
	response: Response;
	finalUrl: string;
	release: () => Promise<void>;
};

const DEFAULT_MAX_REDIRECTS = 3;

/**
 * Credential-bearing headers that must never follow a redirect to a different
 * origin. Standard fetch (browsers, undici) strips these when a redirect
 * crosses origins; because this guard follows redirects manually with
 * `redirect: "manual"`, it must do the same — otherwise a compromised or
 * malicious server can 302 an authenticated request to an attacker origin and
 * capture the caller's `Authorization` bearer token or cookies.
 */
const CROSS_ORIGIN_STRIPPED_HEADERS = [
	"authorization",
	"proxy-authorization",
	"cookie",
] as const;

function stripCredentialHeaders(
	headers: HeadersInit | undefined,
): HeadersInit | undefined {
	if (!headers) {
		return headers;
	}
	const cleaned = new Headers(headers);
	for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) {
		cleaned.delete(name);
	}
	return cleaned;
}

type NodePinnedFetchDefaults = {
	lookupFn: LookupFn;
	pinnedFetchImpl: PinnedLookupFetchLike;
};

let nodePinnedFetchDefaults:
	| Promise<NodePinnedFetchDefaults | null>
	| undefined;

function isNodeLikeRuntime(): boolean {
	const runtime = globalThis as {
		Bun?: unknown;
		process?: { versions?: { node?: string } };
	};
	return Boolean(runtime.Bun || runtime.process?.versions?.node);
}

async function loadNodePinnedFetchDefaults(): Promise<NodePinnedFetchDefaults | null> {
	if (!isNodeLikeRuntime()) {
		return null;
	}
	// On Node-like runtimes the pinned transport is the DNS-rebinding defense.
	// If it fails to load, fail CLOSED: guarded fetches must error rather than
	// silently fall back to the racy unpinned path.
	nodePinnedFetchDefaults ??= import("./node-pinned-fetch.js").then(
		({ nodeLookupFn, nodePinnedFetch }) => ({
			lookupFn: nodeLookupFn,
			pinnedFetchImpl: nodePinnedFetch,
		}),
	);
	try {
		return await nodePinnedFetchDefaults;
	} catch (error) {
		// Do not memoize the failure as a permanent null — allow a retry on the
		// next guarded fetch in case the failure was transient.
		nodePinnedFetchDefaults = undefined;
		logger.error(
			{ error },
			"[FetchGuard] Failed to load the pinned DNS transport on a Node-like runtime; failing closed",
		);
		throw new Error(
			"SSRF guard: pinned DNS transport (node-pinned-fetch) failed to load on a Node-like runtime. " +
				"Refusing to fall back to unpinned fetch (DNS rebinding risk). " +
				`Underlying error: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

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
 * - With a `lookupFn`: resolves and pins DNS to also defend against rebinding
 * - Without a `lookupFn`: synchronous literal-host checks (blocks private/
 *   loopback/link-local IPs and internal hostnames) — usable from
 *   environment-agnostic core, but no rebinding protection
 * - Follows redirects manually, re-validating every hop
 * - Supports timeout and abort signals
 */
export async function fetchWithSsrfGuard(
	params: GuardedFetchOptions,
): Promise<GuardedFetchResult> {
	const fetcher: FetchLike | undefined = params.fetchImpl ?? globalThis.fetch;
	if (!fetcher) {
		throw new Error("fetch is not available");
	}
	const nodeDefaults =
		!params.pinnedFetchImpl && !params.fetchImpl
			? await loadNodePinnedFetchDefaults()
			: null;
	const lookupFn = params.lookupFn ?? nodeDefaults?.lookupFn;
	const pinnedFetchImpl =
		params.pinnedFetchImpl ?? nodeDefaults?.pinnedFetchImpl;

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
	let hopHeaders = params.init?.headers;

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
			let pinned: PinnedHostname | undefined;
			if (lookupFn) {
				// A DNS lookup is available → pin the resolved address(es). This is
				// the strongest mode: it also defends against DNS rebinding.
				const usePolicy = Boolean(
					params.policy?.allowPrivateNetwork ||
						params.policy?.allowedHostnames?.length,
				);
				pinned = usePolicy
					? await resolvePinnedHostnameWithPolicy(parsedUrl.hostname, {
							lookupFn,
							policy: params.policy,
						})
					: await resolvePinnedHostname(parsedUrl.hostname, lookupFn);
			} else {
				// No lookupFn (e.g. environment-agnostic core, which has no node:dns
				// to pin with): fall back to synchronous literal-host checks — block
				// literal private/loopback/link-local IPs (including the
				// octal/hex/decimal forms the OS resolver honors) and blocked
				// internal hostnames. The redirect loop below re-runs this check for
				// every hop, so redirect-to-internal is caught too. This does NOT
				// defend against DNS rebinding (a public name that resolves to a
				// private address) — pass a lookupFn where that matters.
				const allowPrivate = Boolean(params.policy?.allowPrivateNetwork);
				const host = parsedUrl.hostname.trim().toLowerCase().replace(/\.$/, "");
				const allowed = new Set(
					(params.policy?.allowedHostnames ?? []).map((value) =>
						value.trim().toLowerCase().replace(/\.$/, ""),
					),
				);
				if (!allowPrivate && !allowed.has(host)) {
					if (isBlockedHostname(parsedUrl.hostname)) {
						await release();
						throw new SsrfBlockedError(
							`Blocked hostname: ${parsedUrl.hostname}`,
						);
					}
					if (isPrivateIpAddress(parsedUrl.hostname)) {
						await release();
						throw new SsrfBlockedError("Blocked: private/internal IP address");
					}
				}
			}

			const init: RequestInit = {
				...(params.init ? { ...params.init } : {}),
				...(hopHeaders ? { headers: hopHeaders } : {}),
				redirect: "manual",
				...(signal ? { signal } : {}),
			};

			const response =
				pinned && pinnedFetchImpl
					? await pinnedFetchImpl({
							url: parsedUrl,
							init,
							lookup: pinned.lookup,
							addresses: pinned.addresses,
						})
					: await fetcher(parsedUrl.toString(), init);

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
				const nextParsedUrl = new URL(location, parsedUrl);
				const nextUrl = nextParsedUrl.toString();
				if (visited.has(nextUrl)) {
					await release();
					throw new Error("Redirect loop detected");
				}
				visited.add(nextUrl);
				// A redirect hop that crosses origins must not carry the caller's
				// credentials on the next request (matches standard fetch redirect
				// semantics). Keep the stripped header state for later hops too;
				// credentials deleted by a cross-origin redirect are not restored if
				// the chain redirects back to the original origin.
				if (parsedUrl.origin !== nextParsedUrl.origin) {
					hopHeaders = stripCredentialHeaders(hopHeaders);
				}
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
