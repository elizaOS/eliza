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
 * in-flight promise. Each runtime retains a bounded LRU of recent turn slots so
 * concurrent rooms and detached post-turn work cannot evict one another, while
 * memory use remains fixed.
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
 * path, to empty recall context) — recall richness is lost, but the reply is
 * never blocked on an *error*. The provider owns diagnosis of a typed, expected
 * capability-unavailable state; every unexpected failure is reported here with
 * a stable recall code so it remains eligible for runtime diagnostics and
 * escalation without turning a known missing capability into chat noise.
 *
 * There is deliberately NO app-level latency timeout here. A short, arbitrary
 * race on every healthy-but-slow embed would silently degrade vector recall to
 * keyword-only every turn — a feature-kill switch, not a circuit breaker.
 * Bounding a *hung* request is the embedding model handler's job (it owns a
 * real, cancelable request timeout); keeping that bound at the request layer
 * means a slow embed either completes (rich recall) or genuinely errors
 * (fail-open), with no silent middle ground.
 */

import { toElizaError } from "../../errors";
import { recordInferenceSpan } from "../../inference-timing";
import { isCanonicalModelCapabilityDisabled } from "../../runtime/canonical-model-capabilities";
import { getStreamingContext } from "../../streaming-context";
import type { IAgentRuntime } from "../../types";
import { ModelType } from "../../types";
import {
	isExpectedLocalEmbeddingUnavailability,
	modelProviderFailureDetails,
} from "../../utils/expected-local-embedding-unavailability";

function reportUnexpectedEmbeddingFailure(
	runtime: IAgentRuntime,
	error: unknown,
	phase: "synchronous" | "asynchronous",
): void {
	if (isExpectedLocalEmbeddingUnavailability(error)) return;
	const details = modelProviderFailureDetails(error);
	runtime.reportError(
		"DocumentRecall.embedding",
		toElizaError(error, "RECALL_EMBEDDING_FAILED"),
		{
			phase,
			...(details.code ? { providerErrorCode: details.code } : {}),
			...(details.modelType ? { modelType: details.modelType } : {}),
			...(details.provider ? { provider: details.provider } : {}),
			...(details.reason ? { reason: details.reason } : {}),
		},
	);
}

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
 * A runtime can process independent rooms concurrently and can still have
 * post-turn recall work settling when the next room starts. Retaining only one
 * slot lets either turn evict the other's pre-run warm before it is adopted.
 * The small LRU keeps those legitimate overlaps isolated without retaining an
 * unbounded conversation history; evicting a very old slot costs only a cache
 * miss, never a vector attributed to the wrong turn.
 */
interface RuntimeTurnEmbedCaches {
	byRunId: Map<string, TurnEmbedCache>;
	byMessageId: Map<string, TurnEmbedCache>;
	lru: TurnEmbedCache[];
}

const MAX_RECENT_TURN_CACHES = 32;
const turnCaches = new WeakMap<IAgentRuntime, RuntimeTurnEmbedCaches>();

function getRuntimeCaches(runtime: IAgentRuntime): RuntimeTurnEmbedCaches {
	const existing = turnCaches.get(runtime);
	if (existing) return existing;
	const created: RuntimeTurnEmbedCaches = {
		byRunId: new Map(),
		byMessageId: new Map(),
		lru: [],
	};
	turnCaches.set(runtime, created);
	return created;
}

function touchCache(
	caches: RuntimeTurnEmbedCaches,
	cache: TurnEmbedCache,
): void {
	const priorIndex = caches.lru.indexOf(cache);
	if (priorIndex >= 0) caches.lru.splice(priorIndex, 1);
	caches.lru.push(cache);
	while (caches.lru.length > MAX_RECENT_TURN_CACHES) {
		const evicted = caches.lru.shift();
		if (!evicted) return;
		if (evicted.runId && caches.byRunId.get(evicted.runId) === evicted) {
			caches.byRunId.delete(evicted.runId);
		}
		if (
			evicted.messageId &&
			caches.byMessageId.get(evicted.messageId) === evicted
		) {
			caches.byMessageId.delete(evicted.messageId);
		}
	}
}

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
 * case a cache miss, never a wrong vector. Unrelated turns occupy separate
 * bounded LRU slots so one room cannot evict another room's in-flight warm.
 */
function getTurnCache(
	runtime: IAgentRuntime,
	runId: string,
	messageId?: string,
): TurnEmbedCache {
	const caches = getRuntimeCaches(runtime);
	const messageCache =
		messageId !== undefined ? caches.byMessageId.get(messageId) : undefined;
	const runCache = runId !== "" ? caches.byRunId.get(runId) : undefined;
	const existing = messageCache ?? runCache;
	if (existing) {
		if (messageCache && runId !== "" && existing.runId !== runId) {
			if (existing.runId && caches.byRunId.get(existing.runId) === existing) {
				caches.byRunId.delete(existing.runId);
			}
			existing.runId = runId;
			caches.byRunId.set(runId, existing);
		}
		touchCache(caches, existing);
		return existing;
	}
	const fresh: TurnEmbedCache = {
		runId,
		messageId,
		results: new Map(),
		inFlight: new Map(),
	};
	if (runId !== "") caches.byRunId.set(runId, fresh);
	if (messageId !== undefined) caches.byMessageId.set(messageId, fresh);
	touchCache(caches, fresh);
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
	options?: { messageId?: string; signal?: AbortSignal },
): Promise<number[] | null> {
	const signal = options?.signal ?? getStreamingContext()?.abortSignal;
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException("Aborted", "AbortError");
	}
	const normalized = normalizeQuery(queryText);
	if (!normalized) {
		return null;
	}
	// A host that deliberately omits canonical embeddings has no registered
	// TEXT_EMBEDDING handler. Keyword recall is the intended steady state, not a
	// per-turn runtime failure: do not ask useModel to assert a capability the
	// host explicitly does not advertise. Real registered-provider failures
	// still flow through reportUnexpectedEmbeddingFailure below.
	if (
		typeof runtime.getSetting === "function" &&
		isCanonicalModelCapabilityDisabled(runtime, ModelType.TEXT_EMBEDDING)
	) {
		return null;
	}

	let runId: string;
	try {
		runId = runtime.getCurrentRunId();
	} catch (error) {
		// error-policy:J4 Pre-run callers have no active run and explicitly use
		// the message-scoped cache key.
		// No active run yet (a pre-run caller such as document augmentation): fall
		// back to the messageId turn key below so the vector still caches.
		runtime.reportError("DocumentRecall.preRunCacheKey", error);
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
		recordInferenceSpan("embedding-cache:recall", 0, {
			outcome: "cache_hit",
		});
		return cached;
	}

	// Dedupe concurrent identical embeds to a single in-flight round-trip.
	let pending = cache?.inFlight.get(normalized);
	if (pending) {
		recordInferenceSpan("embedding-coalesce:recall", 0, {
			outcome: "coalesced",
		});
	}
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
					...(signal ? { signal } : {}),
				}) as Promise<number[]>,
			);
		} catch (error) {
			if (signal?.aborted) {
				throw signal.reason ?? error;
			}
			// error-policy:J4 semantic recall explicitly degrades to keyword recall;
			// unexpected failures remain observable, while a provider-owned typed
			// unavailable state is already diagnosed at its registration/probe boundary.
			reportUnexpectedEmbeddingFailure(runtime, error, "synchronous");
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
				// error-policy:J5 the awaiting caller below observes and reports the
				// same rejection; this detached cache branch only suppresses duplication.
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
		if (signal?.aborted) {
			throw signal.reason ?? error;
		}
		// error-policy:J4 semantic recall explicitly degrades to keyword recall;
		// unexpected failures remain observable, while a provider-owned typed
		// unavailable state is already diagnosed at its registration/probe boundary.
		reportUnexpectedEmbeddingFailure(runtime, error, "asynchronous");
		return null;
	}
}

/**
 * Declare `aliasText` equivalent to `sourceText` for this turn's recall: any
 * recall caller presenting `aliasText` resolves to `sourceText`'s vector from
 * the per-turn cache instead of issuing its own embed round-trip.
 *
 * The producers are the turn-text rewriters: document augmentation (the
 * contextual-documents envelope on the API chat path) and the message
 * service's incoming-hook seam (the external-content security envelope every
 * untrusted-source message gets). After a rewrite, the in-run recall callers
 * (relevant-conversations, document recall, experience recall) all present
 * the envelope text. Without the alias each rewritten turn pays a second
 * serial embed for a query that is strictly WORSE (injected snippets or
 * security armor drown the user's request); with it, one embed of the clean
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
	} catch (error) {
		// error-policy:J4 Pre-run callers have no active run and explicitly use
		// the message-scoped cache key.
		// No active run (the pre-run augmentation caller): key by messageId, the
		// same fallback embedRecallQuery uses, so both resolve one slot.
		runtime.reportError("DocumentRecall.preRunAliasKey", error);
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
			// error-policy:J5 The source caller observes and reports this same
			// rejection; this branch only prevents duplicate alias-cache work.
		})
		.finally(() => {
			cache.inFlight.delete(aliasKey);
		});
}
