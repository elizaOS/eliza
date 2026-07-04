import { logger } from "../../logger";
import type { IAgentRuntime } from "../../types";
import { ModelType } from "../../types";

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
 * (keyed by `runId`) resolves to a single embed call; concurrent identical
 * embeds share one in-flight promise. The cache is scoped to the turn and
 * evicted when a new turn's `runId` is observed, so it never grows unbounded.
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

/** Normalize query text so trivially-different strings share one cache slot. */
function normalizeQuery(text: string): string {
	return text.trim().replace(/\s+/g, " ").toLowerCase();
}

interface TurnEmbedCache {
	runId: string;
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

function getTurnCache(runtime: IAgentRuntime, runId: string): TurnEmbedCache {
	const existing = turnCaches.get(runtime);
	if (existing && existing.runId === runId) {
		return existing;
	}
	// New turn (or first call): start a fresh cache. The previous turn's entries
	// are dropped wholesale, bounding memory to a single turn's distinct queries.
	const fresh: TurnEmbedCache = {
		runId,
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
 * @returns the embedding vector, or `null` when the embed failed — in which case
 *   the caller MUST fail open to keyword/BM25 recall (or, where no keyword path
 *   exists, to empty recall context); never drop recall silently.
 */
export async function embedRecallQuery(
	runtime: IAgentRuntime,
	queryText: string,
): Promise<number[] | null> {
	const normalized = normalizeQuery(queryText);
	if (!normalized) {
		return null;
	}

	let runId: string;
	try {
		runId = runtime.getCurrentRunId();
	} catch {
		// No active run (e.g. a non-turn caller): skip caching, embed directly.
		runId = "";
	}

	const cache = runId ? getTurnCache(runtime, runId) : null;

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
