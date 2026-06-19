/**
 * Network utilities for Eliza.
 *
 * Provides SSRF protection and secure fetch utilities.
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
