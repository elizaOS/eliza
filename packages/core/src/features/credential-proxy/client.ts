/**
 * Credential-proxy client (issue #11536, phase E3).
 *
 * An HMAC-signed `fetch` wrapper that mirrors `@stwd/proxy-client` semantics:
 * the caller issues a request against a REAL target URL (e.g.
 * `https://api.github.com/repos/o/r`); the client validates that target
 * against a narrow per-host allowlist (explicit host + method + path prefix),
 * signs the canonical request with the shared HMAC key, and forwards it to the
 * configured proxy with an agent-scoped bearer handle and a target header. The
 * proxy injects the real credential outbound (header-only) and returns the
 * response. The raw credential never exists on the caller side.
 *
 * SSRF posture:
 *   - The TARGET host is constrained by the route allowlist (exact host match)
 *     — the primary guard against being tricked into an unintended target.
 *   - The transport to the PROXY goes through `fetchWithSsrfGuard` so redirects
 *     and DNS-rebind are handled, with the proxy hostname explicitly allowed
 *     (the proxy is trusted operator config and is commonly a private/localhost
 *     sidecar, so the default public-only policy would wrongly block it).
 *
 * @module features/credential-proxy/client
 */

import { createHash, createHmac } from "node:crypto";
import { fetchWithSsrfGuard } from "../../network/index.ts";

/** Canonical signing-scheme version. Bump only with a coordinated proxy change. */
export const CREDENTIAL_PROXY_SIGNATURE_VERSION = "v1";
const CANONICAL_PREFIX = "eliza-credential-proxy-v1";

export const CREDENTIAL_PROXY_HEADER_TARGET = "x-eliza-proxy-target";
export const CREDENTIAL_PROXY_HEADER_TIMESTAMP = "x-eliza-proxy-timestamp";
export const CREDENTIAL_PROXY_HEADER_SIGNATURE = "x-eliza-proxy-signature";

/** A single allowlisted route: an exact host + the methods + path prefix the proxy may broker. */
export interface CredentialProxyRoute {
	/** Exact hostname (lower-cased), no port. */
	host: string;
	/** Allowed HTTP methods (upper-cased). */
	methods: readonly string[];
	/** Path (not including query) must start with this prefix. */
	pathPrefix: string;
}

export interface CredentialProxyClientConfig {
	/** Proxy base URL the signed request is forwarded to. */
	url: string;
	/** Agent-scoped bearer handle (never the raw credential). */
	token: string;
	/** Optional HMAC key. When set, requests are signed; the proxy verifies. */
	signingKey?: string;
	/** Per-host allowlist. A request whose target is not covered is rejected. */
	routes: readonly CredentialProxyRoute[];
	/** Injected in tests; defaults to the SSRF-guarded transport. */
	fetchImpl?: typeof fetch;
	/** Clock hook for deterministic tests. */
	now?: () => number;
}

/** Thrown when a target URL is not covered by the route allowlist. */
export class CredentialProxyRouteError extends Error {
	constructor(method: string, url: string) {
		super(
			`Credential-proxy route not allowed: ${method.toUpperCase()} ${url}. ` +
				`No allowlisted route matches this host+method+path.`,
		);
		this.name = "CredentialProxyRouteError";
	}
}

/** Build the exact canonical string that is HMAC'd. Kept dependency-free so the
 * self-contained git credential helper can reproduce it byte-for-byte. */
export function buildCredentialProxyCanonicalString(params: {
	method: string;
	targetHost: string;
	pathAndSearch: string;
	timestamp: string;
	bodyHash: string;
}): string {
	return [
		CANONICAL_PREFIX,
		params.method.toUpperCase(),
		params.targetHost.toLowerCase(),
		params.pathAndSearch,
		params.timestamp,
		params.bodyHash,
	].join("\n");
}

/** Plain (un-keyed) SHA-256 hex of the request body, used in the canonical string. */
export function credentialProxyBodyHash(body: Uint8Array): string {
	return createHash("sha256").update(body).digest("hex");
}

/** Sign a canonical string with the HMAC key, returning `v1=<hex>`. */
export function signCredentialProxyRequest(
	signingKey: string,
	canonical: string,
): string {
	const mac = createHmac("sha256", signingKey).update(canonical).digest("hex");
	return `${CREDENTIAL_PROXY_SIGNATURE_VERSION}=${mac}`;
}

/**
 * Assert a target request is covered by the allowlist. Returns the matched
 * route or throws `CredentialProxyRouteError`. Exported for direct
 * unit-testing of the allowlist independent of the transport.
 */
export function assertRouteAllowed(
	routes: readonly CredentialProxyRoute[],
	method: string,
	target: URL,
): CredentialProxyRoute {
	const host = target.hostname.toLowerCase();
	const upperMethod = method.toUpperCase();
	const match = routes.find(
		(route) =>
			route.host === host &&
			route.methods.includes(upperMethod) &&
			target.pathname.startsWith(route.pathPrefix),
	);
	if (!match) {
		throw new CredentialProxyRouteError(method, target.toString());
	}
	return match;
}

async function readInitBody(
	init: RequestInit | undefined,
): Promise<Uint8Array> {
	const body = init?.body;
	if (body == null) return new Uint8Array(0);
	if (typeof body === "string") return new TextEncoder().encode(body);
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	// Reject streaming/opaque bodies: they cannot be hashed for signing without
	// consuming the stream, and a mis-signed request would fail closed anyway.
	throw new Error(
		"Credential-proxy client requires a string / Uint8Array / ArrayBuffer body (streaming bodies are not signable)",
	);
}

/**
 * Create a `fetch`-shaped function that routes a request against a real target
 * URL through the credential proxy. The returned function throws
 * `CredentialProxyRouteError` for off-allowlist targets before any network
 * call, and never carries the raw credential.
 */
export function createCredentialProxyFetch(
	config: CredentialProxyClientConfig,
): (target: string | URL, init?: RequestInit) => Promise<Response> {
	const proxyUrl = new URL(config.url);
	const now = config.now ?? Date.now;
	const fetchImpl = config.fetchImpl;

	return async function credentialProxyFetch(
		target: string | URL,
		init?: RequestInit,
	): Promise<Response> {
		const targetUrl = target instanceof URL ? target : new URL(target);
		const method = (init?.method ?? "GET").toUpperCase();
		assertRouteAllowed(config.routes, method, targetUrl);

		const body = await readInitBody(init);
		const timestamp = String(Math.floor(now() / 1000));
		const pathAndSearch = `${targetUrl.pathname}${targetUrl.search}`;

		// Forward to the proxy preserving the target path; the proxy reads the
		// target header to know which host to inject the credential for.
		const forwardUrl = new URL(pathAndSearch, proxyUrl);

		const headers = new Headers(init?.headers);
		headers.set("authorization", `Bearer ${config.token}`);
		headers.set(CREDENTIAL_PROXY_HEADER_TARGET, targetUrl.origin);
		headers.set(CREDENTIAL_PROXY_HEADER_TIMESTAMP, timestamp);
		if (config.signingKey) {
			const canonical = buildCredentialProxyCanonicalString({
				method,
				targetHost: targetUrl.hostname,
				pathAndSearch,
				timestamp,
				bodyHash: credentialProxyBodyHash(body),
			});
			headers.set(
				CREDENTIAL_PROXY_HEADER_SIGNATURE,
				signCredentialProxyRequest(config.signingKey, canonical),
			);
		}

		// Forward the caller's original body (already validated as a signable
		// string/Uint8Array/ArrayBuffer by readInitBody); the byte copy above is
		// only used for the signature hash.
		const forwardInit: RequestInit = {
			method,
			headers,
			body: init?.body ?? undefined,
		};

		// Injected fetch (tests) skips the guard; the real transport pins DNS and
		// allows the trusted proxy host even when it is private/localhost.
		if (fetchImpl) {
			return fetchImpl(forwardUrl, forwardInit);
		}
		const { response, release } = await fetchWithSsrfGuard({
			url: forwardUrl.toString(),
			init: forwardInit,
			policy: { allowedHostnames: [proxyUrl.hostname] },
		});
		// release() only clears the guard's abort timer (the response headers have
		// already arrived); freeing it now avoids leaking the timer, and does not
		// close the response body the caller is about to read.
		void release();
		return response;
	};
}
