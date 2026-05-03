/**
 * Network utilities for Eliza.
 *
 * Provides SSRF protection and secure fetch utilities.
 *
 * Note: The dispatcher utilities (undici-based DNS pinning) are Node-specific
 * and should be imported directly from "./network/dispatcher.js" when needed.
 */

export {
	fetchWithSsrfGuard,
	type GuardedFetchOptions,
	type GuardedFetchResult,
} from "./fetch-guard.js";

export {
	assertPublicHostname,
	createPinnedLookup,
	isBlockedHostname,
	isPrivateIpAddress,
	type LookupFn,
	type PinnedHostname,
	resolvePinnedHostname,
	resolvePinnedHostnameWithPolicy,
	SsrfBlockedError,
	type SsrfPolicy,
} from "./ssrf.js";
