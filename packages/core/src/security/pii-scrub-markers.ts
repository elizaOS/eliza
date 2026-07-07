/**
 * Content-addressed done-markers for the async PII scrub rails (#14808).
 *
 * The scrub job is long-running compute that must survive crash/restart with
 * ZERO lost or duplicated work. The issue's chosen resume mechanism is a
 * content-addressed per-item done-marker keyed
 *
 *     pii:<sha256(content)>:v<rulesetVersion>
 *
 * exactly like the media store's content-addressing and the compensating-write
 * `recon:<txid>:refund` precedent. It has two properties the job relies on:
 *
 *   1. **Content-addressed idempotency.** The key is derived only from the
 *      content bytes + the active ruleset version. Re-enqueuing the SAME content
 *      under the SAME ruleset resolves to the SAME marker, so a re-scrub of
 *      unchanged content is a no-op (`isScrubDone` short-circuits before any
 *      model call). Editing the content (different sha) OR bumping the ruleset
 *      (different `v<...>`) produces a NEW key, so genuinely-changed content is
 *      re-scrubbed rather than incorrectly skipped.
 *
 *   2. **Crash-and-rerun with zero cursor state.** The marker is written to the
 *      runtime cache (a DB-backed durable store), so a `kill -9` mid-run loses
 *      only in-flight work: on restart every already-completed item's marker is
 *      still present and its re-drain skips. There is no cursor/offset to
 *      corrupt - resume is implicit in the content-addressed key space.
 *
 * The marker is written ONLY after the scrub for that item has fully succeeded
 * (verdicts applied / write-back done). A crash between "model returned" and
 * "marker written" simply re-runs that item on restart - at-least-once with an
 * idempotent write, never at-most-once. The seam's fail-closed contract
 * (`scrubWithEscalation` throws on any un-inspectable residue) guarantees a
 * failed item is NOT marked done, so it is retried, never silently passed.
 */

import { createHash } from "../utils/crypto-compat.js";

/** Prefix for every PII scrub done-marker key. */
export const PII_SCRUB_MARKER_PREFIX = "pii";

/**
 * The stored shape of a done-marker. Kept intentionally small - its PRESENCE is
 * the signal; the fields are audit metadata (which ruleset, which model, when).
 * It NEVER stores the scrubbed content or any raw span (that would re-introduce
 * the PII into the cache the scrub exists to remove).
 */
export interface PiiScrubDoneMarker {
	/** Hex sha256 of the exact content that was scrubbed. */
	readonly contentHash: string;
	/** Ruleset version the scrub was performed under. */
	readonly rulesetVersion: string;
	/** The model id that served the escalation (or `"tier0"` when no model ran). */
	readonly modelId: string;
	/** Unix ms the marker was written. */
	readonly completedAt: number;
	/**
	 * True when tier-0 detectors fully covered the content and NO model call was
	 * made. Purely observability - the marker's presence is what makes the item
	 * skip regardless.
	 */
	readonly tier0Only: boolean;
}

/**
 * Hex sha256 of the given content. The content-address half of the key. A pure
 * function of the bytes: identical content always hashes identically, so it is
 * the stable idempotency handle.
 */
export function hashScrubContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/**
 * Build the done-marker cache key `pii:<sha256(content)>:v<rulesetVersion>` from
 * an already-computed content hash. Use {@link scrubMarkerKeyForContent} when
 * you have the raw content instead.
 *
 * @throws when `rulesetVersion` is empty - an empty version would collapse the
 *   marker namespace across ruleset upgrades and let a stale-ruleset scrub be
 *   treated as current (a fail-open we refuse to allow).
 */
export function scrubMarkerKey(
	contentHash: string,
	rulesetVersion: string,
): string {
	if (typeof rulesetVersion !== "string" || rulesetVersion.length === 0) {
		throw new Error(
			"[pii-scrub-markers] rulesetVersion must be a non-empty string; refusing to build a version-collapsed marker key",
		);
	}
	if (typeof contentHash !== "string" || contentHash.length === 0) {
		throw new Error(
			"[pii-scrub-markers] contentHash must be a non-empty string",
		);
	}
	return `${PII_SCRUB_MARKER_PREFIX}:${contentHash}:v${rulesetVersion}`;
}

/**
 * Build the done-marker key directly from raw content: hashes the content, then
 * composes `pii:<sha256>:v<rulesetVersion>`.
 */
export function scrubMarkerKeyForContent(
	content: string,
	rulesetVersion: string,
): string {
	return scrubMarkerKey(hashScrubContent(content), rulesetVersion);
}

/**
 * Minimal runtime cache surface the marker helpers need. A structural subset of
 * `IAgentRuntime` so the helpers are unit-testable with a trivial fake and do
 * not drag the whole runtime type into a pure-idempotency module.
 */
export interface ScrubMarkerCache {
	getCache<T>(key: string): Promise<T | undefined>;
	setCache<T>(key: string, value: T): Promise<boolean>;
	deleteCache(key: string): Promise<boolean>;
}

/**
 * True when this exact content has already been scrubbed under this exact
 * ruleset version - the idempotency check the drain runs BEFORE any model call.
 * A hit means "re-scrub of unchanged content" and the item no-ops.
 */
export async function isScrubDone(
	cache: ScrubMarkerCache,
	content: string,
	rulesetVersion: string,
): Promise<boolean> {
	const key = scrubMarkerKeyForContent(content, rulesetVersion);
	const marker = await cache.getCache<PiiScrubDoneMarker>(key);
	return marker !== undefined && marker !== null;
}

/**
 * Persist the done-marker for a completed item. Idempotent: writing the same
 * key twice (a crash-retry that re-scrubbed an item whose marker was already
 * present) simply overwrites with the same logical value - never a duplicate
 * side effect. Call ONLY after the scrub write-back for the item has succeeded.
 */
export async function markScrubDone(
	cache: ScrubMarkerCache,
	content: string,
	marker: Omit<PiiScrubDoneMarker, "contentHash" | "completedAt"> & {
		completedAt?: number;
	},
): Promise<boolean> {
	const contentHash = hashScrubContent(content);
	const key = scrubMarkerKey(contentHash, marker.rulesetVersion);
	const record: PiiScrubDoneMarker = {
		contentHash,
		rulesetVersion: marker.rulesetVersion,
		modelId: marker.modelId,
		tier0Only: marker.tier0Only,
		completedAt: marker.completedAt ?? Date.now(),
	};
	return cache.setCache<PiiScrubDoneMarker>(key, record);
}

/**
 * Read the stored marker (or `undefined`). Used by tests / audits to prove a
 * done-marker table dump - the acceptance-criteria evidence.
 */
export async function getScrubMarker(
	cache: ScrubMarkerCache,
	content: string,
	rulesetVersion: string,
): Promise<PiiScrubDoneMarker | undefined> {
	const key = scrubMarkerKeyForContent(content, rulesetVersion);
	const marker = await cache.getCache<PiiScrubDoneMarker>(key);
	return marker ?? undefined;
}
