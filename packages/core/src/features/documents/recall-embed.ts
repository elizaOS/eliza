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
 * **Alias keys for rewritten prompts.** Document augmentation rewrites the
 * turn's `content.text` into a contextual-documents envelope AFTER the recall
 * embed of the clean user prompt already ran. Every in-run recall caller then
 * presents the envelope text, whose normalized key would miss the cached
 * vector and issue a second, serial embed round-trip for the same turn.
 * `aliasRecallQuery` lets the rewriter declare both texts equivalent for this
 * turn's recall, mapping the envelope key onto the clean-prompt vector — which
 * is also the semantically correct recall query (the user's request, not the
 * injected document context).
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
		try {
			// Promise.resolve guards a model handler that returns a bare value (or
			// nothing); the catch guards one that throws synchronously. Both are the
			// same failure as a rejected embed and must fail OPEN here — several
			// callers (the augmentation warm, the message-service prefetch) invoke
			// this fire-and-forget, so a rejection escaping this async fn would
			// surface as an unhandled rejection instead of degraded recall.
			pending = Promise.resolve(
				runtime.useModel(ModelType.TEXT_EMBEDDING, {
					text: queryText,
				}) as Promise<number[]>,
			);
		} catch (error) {
			logger.debug(
				{
					src: "core:documents:recall-embed",
					error: error instanceof Error ? error.message : String(error),
				},
				"Recall-query embed threw synchronously; failing open to keyword recall",
			);
			return null;
		}
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
		const vector = await pending;
		// A handler that resolved to a non-array (e.g. undefined) failed to embed;
		// report that as the fail-open null, not a garbage value.
		return Array.isArray(vector) ? vector : null;
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

/**
 * Declare `aliasText` equivalent to `sourceText` for this turn's recall: any
 * recall caller presenting `aliasText` resolves to `sourceText`'s vector from
 * the per-turn cache instead of issuing its own embed round-trip.
 *
 * The one producer is document augmentation: after it rewrites the turn's
 * message text into the contextual-documents envelope, the in-run recall
 * callers (TTFT prefetch, relevant-conversations, FACTS) all present the
 * envelope text. Without the alias each turn with a document match pays a
 * second serial embed for a query that is strictly WORSE (the injected
 * document snippets drown the user's request); with it, one embed of the clean
 * prompt serves the whole turn.
 *
 * The alias joins an in-flight source embed rather than waiting for it, so it
 * can be registered synchronously right after a fire-and-forget
 * `embedRecallQuery` warm of the source text. When the source was never
 * embedded (or its embed failed), this is a no-op and alias-text callers embed
 * directly — the fail-open contract is unchanged.
 */
export function aliasRecallQuery(
	runtime: IAgentRuntime,
	options: { messageId?: string; sourceText: string; aliasText: string },
): void {
	const sourceKey = normalizeQuery(options.sourceText);
	const aliasKey = normalizeQuery(options.aliasText);
	if (!sourceKey || !aliasKey || sourceKey === aliasKey) {
		return;
	}

	let runId: string;
	try {
		runId = runtime.getCurrentRunId();
	} catch {
		// No active run (the pre-run augmentation caller): key by messageId, the
		// same fallback embedRecallQuery uses, so both resolve one slot.
		runId = "";
	}
	if (runId === "" && options.messageId === undefined) {
		// No turn key at all — nothing is cached for this caller, so there is no
		// slot to alias into.
		return;
	}

	const cache = getTurnCache(runtime, runId, options.messageId);
	const resolved = cache.results.get(sourceKey);
	if (resolved) {
		cache.results.set(aliasKey, resolved);
		return;
	}

	const pending = cache.inFlight.get(sourceKey);
	if (!pending) {
		return;
	}
	// Mirror embedRecallQuery's in-flight bookkeeping under the alias key so a
	// concurrent alias-text caller joins the source round-trip instead of
	// starting its own.
	cache.inFlight.set(aliasKey, pending);
	void pending
		.then((vector) => {
			if (Array.isArray(vector) && vector.length > 0) {
				cache.results.set(aliasKey, vector);
			}
		})
		.catch(() => {
			// Swallow: the source caller logs + fails open; an alias-text caller
			// awaiting this shared promise fails open through its own catch.
		})
		.finally(() => {
			cache.inFlight.delete(aliasKey);
		});
}
