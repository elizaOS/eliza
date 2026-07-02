/**
 * Network utilities for Eliza.
 *
 * Provides SSRF protection and secure fetch utilities.
 */

export {
	fetchWithSsrfGuard,
	type GuardedFetchOptions,
	type GuardedFetchResult,
	type PinnedLookupFetchLike,
	type PinnedLookupFetchParams,
} from "./fetch-guard.js";

export { nodeLookupFn, nodePinnedFetch } from "./node-pinned-fetch.js";

export {
	assertPublicHostname,
	createPinnedLookup,
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
