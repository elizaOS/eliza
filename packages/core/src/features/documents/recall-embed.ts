/**
 * THE shared recall-query embedder on the reply hot path.
 *
 * Every recall provider that embeds the current user message to vector-search
 * memory routes through here: document/knowledge recall
 * (`DocumentService._vectorSearch`/`_hybridSearch`), experience recall
 * (`ExperienceService.findSimilarExperiences`), and the relevant-conversations
 * provider. Because they all call this one function with the same runtime +
 * `runId` + (normalized) query text, the per-turn dedupe below collapses the
 * 3 independent embed round-trips per turn into a single one.
 *
 * **Per-turn cache + in-flight dedupe.** The same query text is embedded more
 * than once per turn (vector + hybrid document search, experience recall,
 * relevant-conversations). Identical normalized query text within one turn
 * resolves to a single embed call; concurrent identical embeds share one
 * in-flight promise. The cache is scoped to the turn and evicted when a new
 * turn's key is observed, so it never grows unbounded.
 *
 * **Turn key = `runId`, plus a `messageId` that survives the run transition.**
 * The API chat path embeds the user query during document augmentation *before*
 * `startRun`. `AgentRuntime.getCurrentRunId()` lazily mints a transient run id
 * there, so the augmentation embed would otherwise cache under an id that
 * `startRun` immediately replaces — orphaning the vector and forcing a second
 * identical embed in-run. Augmentation therefore also presents the turn's
 * `messageId`; the in-run TTFT prefetch presents the same `messageId` and ADOPTS
 * the slot, re-stamping it with the real `runId` so every later `runId`-only
 * recall caller (compose-time providers) shares the already-warmed vector
 * instead of issuing a second round-trip. A `runId`-only caller never adopts a
 * slot without a `messageId` match, so a concurrent turn's vectors can never be
 * attributed to the wrong turn (worst case: a cache miss, never a wrong vector).
 * A caller with neither key (background/non-turn) embeds directly, uncached.
 *
 * **Fail-open on error only.** A failed embed (the model handler rejects — e.g.
 * its own request timeout aborts, or the provider errors) returns `null`; the
 * caller falls open to keyword/BM25 recall (or, for callers with no keyword
 * path, to empty recall context) — recall richness is lost, the reply is never
 * blocked on an *error*, and recall is never silently dropped (we log it).
 *
 * There is deliberately NO app-level latency timeout here. A short, arbitrary
 * race on every healthy-but-slow embed would silently degrade vector recall to
 * keyword-only every turn — a feature-kill switch, not a circuit breaker.
 * Bounding a *hung* request is the embedding model handler's job (it owns a
 * real, cancelable request timeout); keeping that bound at the request layer
 * means a slow embed either completes (rich recall) or genuinely errors
 * (fail-open), with no silent middle ground.
 */
import { logger } from "../../logger";
import type { IAgentRuntime } from "../../types";
import { ModelType } from "../../types";

/** Normalize query text so trivially-different strings share one cache slot. */
function normalizeQuery(text: string): string {
	return text.trim().replace(/\s+/g, " ").toLowerCase();
}

interface TurnEmbedCache {
	/** The run id this slot is keyed under: the live run id in-run, or (pre-run)
	 * the transient id `getCurrentRunId` minted / `""` if it threw — re-stamped to
	 * the live id on adoption. */
	runId: string;
	/** Turn message id — the pre-run turn key, set when the caller presents one. */
	messageId?: string;
	/** Resolved vectors keyed by normalized query text. */
	results: Map<string, number[]>;
	/** In-flight embeds keyed by normalized query text (dedupe concurrent calls). */
	inFlight: Map<string, Promise<number[]>>;
}

/**
 * One cache per runtime instance, scoped to the current turn. A `WeakMap` keyed
 * by the runtime keeps this self-contained (no runtime field, no global leak)
 * and lets the cache be GC'd with the runtime.
 */
const turnCaches = new WeakMap<IAgentRuntime, TurnEmbedCache>();

/**
 * Resolve the current turn's cache, creating a fresh one on a turn boundary.
 *
 * A cache matches when its `runId` equals a non-empty caller `runId`, OR when
 * its `messageId` equals the caller's `messageId`. On a `messageId` match where
 * the caller has a live `runId` that differs from the slot's, the slot is
 * ADOPTED — its `runId` is re-stamped in place so subsequent `runId`-only
 * callers this turn resolve to it.
 *
 * Adoption spans the pre-run→in-run transition on the API chat path:
 * `AgentRuntime.getCurrentRunId()` lazily mints a run id, so the pre-run
 * document-augmentation embed caches under a transient id; `startRun()` then
 * mints the turn's real id. Keying the pre-run embed by `messageId` lets the
 * in-run prefetch (same `messageId`) re-stamp the slot with the real `runId`
 * instead of orphaning that vector under the transient one.
 *
 * A `runId`-only caller (no `messageId`) matches only on a real `runId`, so it
 * can never promote an unrelated concurrent turn's slot into its own — worst
 * case a cache miss, never a wrong vector. No match replaces the slot wholesale,
 * bounding memory to a single turn's distinct queries.
 */
function getTurnCache(
	runtime: IAgentRuntime,
	runId: string,
	messageId?: string,
): TurnEmbedCache {
	const existing = turnCaches.get(runtime);
	if (existing) {
		const runIdMatch = runId !== "" && existing.runId === runId;
		const messageIdMatch =
			messageId !== undefined && existing.messageId === messageId;
		if (runIdMatch || messageIdMatch) {
			if (messageIdMatch && runId !== "" && existing.runId !== runId) {
				existing.runId = runId;
			}
			return existing;
		}
	}
	const fresh: TurnEmbedCache = {
		runId,
		messageId,
		results: new Map(),
		inFlight: new Map(),
	};
	turnCaches.set(runtime, fresh);
	return fresh;
}

/**
 * Embed the recall query, cached + deduped for the current turn ACROSS all
 * recall providers (documents, experience, relevant-conversations) sharing the
 * same runtime + `runId`.
 *
 * @param options.messageId - the turn's message id, supplied by pre-run callers
 *   (document augmentation) so the embed caches before a `runId` exists and the
 *   first in-run caller adopts it. Omit for the common in-run recall callers,
 *   which key off `runId`.
 * @returns the embedding vector, or `null` when the embed failed — in which case
 *   the caller MUST fail open to keyword/BM25 recall (or, where no keyword path
 *   exists, to empty recall context); never drop recall silently.
 */
export async function embedRecallQuery(
	runtime: IAgentRuntime,
	queryText: string,
	options?: { messageId?: string },
): Promise<number[] | null> {
	const normalized = normalizeQuery(queryText);
	if (!normalized) {
		return null;
	}

	let runId: string;
	try {
		runId = runtime.getCurrentRunId();
	} catch {
		// No active run yet (a pre-run caller such as document augmentation): fall
		// back to the messageId turn key below so the vector still caches.
		runId = "";
	}

	const messageId = options?.messageId;
	// Cache whenever there is a turn key: a live `runId`, or a pre-run
	// `messageId`. A caller with neither (background/non-turn) embeds directly.
	const cache =
		runId !== "" || messageId !== undefined
			? getTurnCache(runtime, runId, messageId)
			: null;

	const cached = cache?.results.get(normalized);
	if (cached) {
		return cached;
	}

	// Dedupe concurrent identical embeds to a single in-flight round-trip.
	let pending = cache?.inFlight.get(normalized);
	if (!pending) {
		pending = runtime.useModel(ModelType.TEXT_EMBEDDING, {
			text: queryText,
		}) as Promise<number[]>;
		cache?.inFlight.set(normalized, pending);
		// Populate the per-turn result cache so a later identical query in the same
		// turn reuses this vector instead of issuing a new call, and clear the
		// in-flight entry once settled.
		void pending
			.then((vector) => {
				if (Array.isArray(vector) && vector.length > 0) {
					cache?.results.set(normalized, vector);
				}
			})
			.catch(() => {
				// Swallow: the awaiting caller below logs + fails open. Avoids an
				// unhandled rejection from the detached cache-population branch.
			})
			.finally(() => {
				cache?.inFlight.delete(normalized);
			});
	}

	try {
		return await pending;
	} catch (error) {
		logger.debug(
			{
				src: "core:documents:recall-embed",
				error: error instanceof Error ? error.message : String(error),
			},
			"Recall-query embed failed; failing open to keyword recall",
		);
		return null;
	}
}
