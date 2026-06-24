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
 * `runId` + (normalized) query text, the per-turn dedupe below collapses what
 * used to be 3 independent embed round-trips per turn into a single one.
 *
 * **Design principle (issue #47):** a slow embed must cost recall RICHNESS,
 * never reply LATENCY. The recall embeds the query text with a blocking
 * `useModel(TEXT_EMBEDDING)` round-trip BEFORE the vector `searchMemories`. On
 * managed cloud agents that round-trip is 3-6.6s and runs during `composeState`,
 * entirely before the first reply token — so it dominated TTFT (~23-30s/turn).
 *
 * Two bounded mitigations live here, both fail-open:
 *
 * 1. **Timeout + fail-open.** The recall embed is raced against a short timeout
 *    ({@link RECALL_EMBED_TIMEOUT_MS}). On timeout OR error this returns `null`;
 *    the caller then falls back to pure keyword/BM25 recall (or, for callers
 *    with no keyword path, no recall context) and proceeds with reply
 *    generation. The embed therefore adds AT MOST the timeout to TTFT, never the
 *    full serial cost, and recall is never silently dropped.
 *
 * 2. **Per-turn cache + in-flight dedupe.** The same query text is embedded more
 *    than once per turn (vector + hybrid document search, experience recall,
 *    relevant-conversations). Identical normalized query text within one turn
 *    (keyed by `runId`) resolves to a single embed call; concurrent identical
 *    embeds share one in-flight promise. The cache is scoped to the turn and
 *    evicted when a new turn's `runId` is observed, so it never grows unbounded.
 */

/**
 * Max time the recall-query embed may block the reply path. On timeout the
 * caller fails open to keyword/BM25 recall. Kept short: the whole point is that
 * a slow/unavailable embed costs recall richness, not reply latency.
 */
export const RECALL_EMBED_TIMEOUT_MS = 1500;

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
 * Embed the recall query, bounded by {@link RECALL_EMBED_TIMEOUT_MS} and cached
 * + deduped for the current turn ACROSS all recall providers (documents,
 * experience, relevant-conversations) sharing the same runtime + `runId`.
 *
 * @returns the embedding vector, or `null` when the embed timed out or failed —
 *   in which case the caller MUST fail open to keyword/BM25 recall (or, where no
 *   keyword path exists, to empty recall context); never drop recall silently.
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
		// No active run (e.g. a non-turn caller): skip caching, still time-bound.
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
		// Detach cleanup from the timeout race below: the embed may still resolve
		// after we've already failed open, and a later identical query in the same
		// turn should reuse that resolved vector instead of issuing a new call.
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

	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timeoutId = setTimeout(() => resolve(null), RECALL_EMBED_TIMEOUT_MS);
	});

	try {
		const vector = await Promise.race([pending, timeout]);
		if (vector === null) {
			logger.debug(
				{
					src: "core:documents:recall-embed",
					timeoutMs: RECALL_EMBED_TIMEOUT_MS,
				},
				"Recall-query embed exceeded timeout; failing open to keyword recall",
			);
			return null;
		}
		return vector;
	} catch (error) {
		logger.debug(
			{
				src: "core:documents:recall-embed",
				error: error instanceof Error ? error.message : String(error),
			},
			"Recall-query embed failed; failing open to keyword recall",
		);
		return null;
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}
	}
}
