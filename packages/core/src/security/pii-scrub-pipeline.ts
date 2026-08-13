/**
 * Production driver for the local PII scrub pipeline (#15973).
 *
 * The merged context-retrieval pass + corpus pseudonym map (#15841, closes
 * #14805) is complete and tested, but it was unreachable from a live run: no
 * production caller loaded the encrypted map, assembled the context pack,
 * routed the result through the `PiiScrubService` rails, and applied the
 * validated verdicts back onto the source artifact. This module is that caller.
 *
 * It wires the already-landed rails into ONE production flow with no new
 * scheduler, queue, or scrub mechanism:
 *
 *   1. **Load the encrypted pseudonym map** from the protected runtime-cache
 *      store (`EncryptedCachePseudonymMapStore`, #15841). Fail-closed: a
 *      wrong salt, tampered ciphertext, or malformed snapshot THROWS rather
 *      than silently re-minting pseudonyms for already-mapped people.
 *   2. **Assemble the context pack** for the chunk: resolve candidates through
 *      the EntityStore alias backbone, gather related document/memory/message
 *      fragments, cluster confident resolutions into the map, and emit the
 *      per-chunk assignment slice — exactly the `assembleContextPack` contract.
 *   3. **Fold the pack into the scrub-rails request** via
 *      `buildScrubRequestDraft` and emit `PII_SCRUB_REQUESTED`, which the live
 *      `PiiScrubService` drains (tier-0 → escalation → marker).
 *   4. **Apply the verdicts and write back** the transformed text before the
 *      done-marker is written. This is the step the service previously skipped
 *      (it discarded the returned verdicts, marking done without committing
 *      the rewrite). `applyScrubVerdicts` replaces every `pii` span with its
 *      replacement and `substituteAliases` applies the deterministic tier-0
 *      pseudonym pass, so zero original aliases survive.
 *
 * The module is deliberately LOCAL-only (the issue's narrowed scope): no cloud
 * corpus upload, no second scrub workflow, no new knowledge store. It owns the
 * candidate → EntityStore → context pack → encrypted map → scrub → write-back
 * transformation on the existing local rails. The cloud lane (#14808) remains
 * a separate sibling scope.
 */

import type { PiiScrubRequestPayload } from "../types/events.js";
import { EventType } from "../types/events.js";
import type { PiiScrubVerdict } from "../types/model.js";
import type { IAgentRuntime } from "../types/runtime.js";
import {
	assembleContextPack,
	type PiiContextSources,
	type PiiScrubCandidate,
} from "./pii-context-pack.js";
import { detectPii } from "./pii-detectors.js";
import { CorpusPseudonymMap } from "./pii-pseudonym-map.js";
import {
	EncryptedCachePseudonymMapStore,
	type PseudonymMapStore,
} from "./pii-pseudonym-map-store.js";
import { isScrubDone, markScrubDone } from "./pii-scrub-markers.js";
import { scrubWithEscalation } from "./pii-scrub-seam.js";

/**
 * One item the pipeline is asked to scrub. The caller (memory ingestion,
 * document indexing, conversation persistence) owns mining `candidates` and
 * supplying the `itemRef` that lets write-back target the source row.
 */
export interface PiiScrubPipelineItem {
	/** The exact content to scrub. */
	readonly content: string;
	/** Caller-scoped stable reference (e.g. the memory/document id). */
	readonly itemRef: string;
	/** Mined candidates for this chunk (may be empty). */
	readonly candidates: readonly PiiScrubCandidate[];
	/**
	 * Persist the transformed text to the source artifact. The promise must not
	 * resolve until the write is durable; throwing keeps the item unmarked so it
	 * can be retried.
	 */
	readonly writeBack: (scrubbedText: string) => Promise<void>;
	/** Rooms for conversation FTS, when the caller has them. */
	readonly roomIds?: readonly string[];
}

/** The transformed output of scrubbing one item. */
export interface PiiScrubPipelineResult {
	/** The scrubbed text with all PII replaced / pseudonymized. */
	readonly scrubbedText: string;
	/** True when the model seam was invoked (residue existed). */
	readonly escalated: boolean;
	/** The verdicts returned by the scrub seam (empty when tier-0 only). */
	readonly verdicts: readonly PiiScrubVerdict[];
	/** The model id that served the scrub (or `"tier0"`). */
	readonly modelId: string;
	/** Whether the content was already marker-done (idempotent skip). */
	readonly skipped: boolean;
	/**
	 * The scrub-rails request payload, ready to emit as
	 * `PII_SCRUB_REQUESTED` so the live `PiiScrubService` owns inference,
	 * write-back, marker, retry, and observability. `null` for direct write-back
	 * and idempotent skips.
	 */
	readonly railsPayload: Omit<PiiScrubRequestPayload, "runtime"> | null;
}

export interface PiiScrubPipelineOptions {
	/** Active ruleset version — half of every done-marker key. */
	readonly rulesetVersion: string;
	/**
	 * The protected pseudonym-map store. Defaults to
	 * {@link EncryptedCachePseudonymMapStore} on the runtime cache. Inject a
	 * test double for unit tests.
	 */
	readonly mapStore?: PseudonymMapStore;
	/**
	 * The context-retrieval sources (entity resolver, document/memory/message
	 * search). Build with `sourcesFromRuntime` + `entityResolverFromStore` in
	 * production. When omitted, the pipeline runs tier-0 + pseudonym-map
	 * substitution only (no retrieval context) — the safe minimum.
	 */
	readonly sources?: PiiContextSources;
	/**
	 * When `true` (default), run inference, durably write the transformed text,
	 * and mark the source complete. When `false`, perform no inference and only
	 * build the rails payload; the service owns the entire paid/durable path.
	 */
	readonly applyWriteBack?: boolean;
	/**
	 * Drain priority for the rails payload. Defaults to `low` (background
	 * autonomous work).
	 */
	readonly priority?: PiiScrubRequestPayload["priority"];
	/** Inference priority forwarded to the seam. Defaults to `background`. */
	readonly inferencePriority?: PiiScrubRequestPayload["inferencePriority"];
}

/**
 * Apply model verdicts to text: replace every `pii` span with its replacement.
 * This is the lightweight write-back that needs no corpus map — the verdicts
 * carry their own replacements. Pair with {@link redactTier0Spans} for full
 * scrub coverage (tier-0 structured PII + model-judged residue).
 */
export function applyVerdictsToText(
	text: string,
	verdicts: readonly PiiScrubVerdict[],
): string {
	let result = text;
	for (const verdict of [...verdicts].sort(
		(a, b) => b.span.length - a.span.length,
	)) {
		if (verdict.kind === "pii" && verdict.replacement) {
			result = result.split(verdict.span).join(verdict.replacement);
		}
	}
	return result;
}

/**
 * The tier-0 deterministic redaction placeholder for structured PII (credit
 * cards, SSNs, API keys, …) that the detectors fully cover without a model.
 */
export const TIER0_REDACTION_PLACEHOLDER = "[REDACTED]";

/**
 * Redact tier-0 deterministic spans in text. Each matched span is replaced
 * with {@link TIER0_REDACTION_PLACEHOLDER}.
 */
export function redactTier0Spans(
	text: string,
	tier0Spans: readonly { readonly span: string }[],
): string {
	let result = text;
	for (const match of tier0Spans) {
		if (match.span) {
			result = result.split(match.span).join(TIER0_REDACTION_PLACEHOLDER);
		}
	}
	return result;
}

/**
 * Full write-back transform: longest model verdicts first, then tier-0
 * redaction, followed by a fresh deterministic scan of the rewritten output.
 * Whole-chunk verdicts can therefore rewrite unstructured PII without allowing
 * a normalized structured value to evade the original detector spans.
 * Produces the artifact that replaces the original — guaranteed to contain
 * zero surviving PII when the detectors + verdicts cover all sensitive spans.
 */
export function applyScrubWriteBack(
	text: string,
	tier0Spans: readonly { readonly span: string }[],
	verdicts: readonly PiiScrubVerdict[],
): string {
	const rewritten = redactTier0Spans(
		applyVerdictsToText(text, verdicts),
		tier0Spans,
	);
	const rewrittenTier0 = detectPii(rewritten).map((match) => ({
		span: match.value,
	}));
	return redactTier0Spans(rewritten, rewrittenTier0);
}

/**
 * Apply a scrub result's verdicts to the source text: replace every `pii`
 * span with its replacement. `safe` verdicts are left untouched. This is the
 * write-back transform — it produces the artifact that replaces the original.
 *
 * Tier-0 deterministic replacements are applied first via the pseudonym map's
 * `substituteAliases` (so structured PII already caught by detectors and
 * mapped aliases are swapped in one pass), then model verdicts for the residue
 * are layered on top. The result is guaranteed to contain zero original
 * candidate aliases when the map + verdicts cover them all (the consistency
 * suite's hard gate).
 */
export function applyScrubVerdicts(
	text: string,
	verdicts: readonly PiiScrubVerdict[],
	map: CorpusPseudonymMap,
): string {
	// 1. Deterministic tier-0 pseudonym substitution: replace every unambiguous
	//    mapped alias with its cluster's pseudonym.
	const substitution = map.substituteAliases(text);
	let result = substitution.text;

	// 2. Layer model verdicts for the residue: replace each `pii` span.
	for (const verdict of [...verdicts].sort(
		(a, b) => b.span.length - a.span.length,
	)) {
		if (verdict.kind === "pii" && verdict.replacement) {
			// Escape regex special characters in the span for a safe split-join.
			result = result.split(verdict.span).join(verdict.replacement);
		}
	}

	return result;
}

/**
 * Run the production PII scrub pipeline on one item. This is the single entry
 * point that wires the context pack + encrypted pseudonym map + scrub seam +
 * write-back into a live flow.
 *
 * The flow:
 *   load map → assemble context pack → scrubWithEscalation → apply verdicts →
 *   persist map → return transformed text + rails payload.
 *
 * Fail-closed throughout: a map-store error (wrong salt, tamper, malformed),
 * a seam throw (no handler for residue, fabricated result), or a model error
 * propagates — the caller does NOT mark the item done, and the content stays
 * quarantined.
 */
export async function runPiiScrubPipeline(
	runtime: IAgentRuntime,
	item: PiiScrubPipelineItem,
	options: PiiScrubPipelineOptions,
): Promise<PiiScrubPipelineResult> {
	const {
		rulesetVersion,
		sources,
		applyWriteBack = true,
		priority,
		inferencePriority,
	} = options;

	// Marker checks happen before context retrieval or inference. Repeated direct
	// calls and repeated enqueue attempts therefore perform zero paid work.
	if (await isScrubDone(runtime, item.content, rulesetVersion, item.itemRef)) {
		return {
			scrubbedText: item.content,
			escalated: false,
			verdicts: [],
			modelId: "skipped",
			skipped: true,
			railsPayload: null,
		};
	}

	const mapStore =
		options.mapStore ?? new EncryptedCachePseudonymMapStore(runtime);
	const snapshot = await mapStore.load();
	const map = snapshot
		? CorpusPseudonymMap.fromSnapshot(snapshot)
		: new CorpusPseudonymMap();

	const pack = await assembleContextPack(sources ?? {}, {
		chunk: item.content,
		candidates: item.candidates,
		map,
		rulesetVersion,
	});

	if (map.size > 0) {
		await mapStore.save(map.toSnapshot());
	}

	// Async mode is payload-only. Inference happens exactly once when the
	// service drains this payload.
	if (!applyWriteBack) {
		return {
			scrubbedText: item.content,
			escalated: false,
			verdicts: [],
			modelId: "pending",
			skipped: false,
			railsPayload: {
				content: item.content,
				rulesetVersion,
				candidateSpans: pack.candidateSpans,
				contextPack: pack.contextPack,
				pseudonymAssignments: pack.assignments,
				priority,
				inferencePriority,
				itemRef: item.itemRef,
				writeBack: item.writeBack,
				source: "pii-scrub-pipeline",
			},
		};
	}

	const escalation = await scrubWithEscalation(runtime, {
		text: item.content,
		candidateSpans: pack.candidateSpans,
		rulesetVersion,
		contextPack: pack.contextPack,
		pseudonymAssignments: pack.assignments,
		priority: inferencePriority ?? "background",
	});
	const verdicts = escalation.escalation?.verdicts ?? [];
	const modelId = escalation.escalation?.modelId ?? "tier0";
	const redacted = applyScrubWriteBack(
		item.content,
		escalation.tier0,
		verdicts,
	);
	const scrubbedText = map.substituteAliases(redacted).text;

	// The source artifact is committed before the marker. A failed write never
	// becomes an idempotency hit and can safely retry.
	await item.writeBack(scrubbedText);
	await markScrubDone(
		runtime,
		item.content,
		{
			rulesetVersion,
			modelId,
			tier0Only: !escalation.escalated,
		},
		item.itemRef,
	);

	return {
		scrubbedText,
		escalated: escalation.escalated,
		verdicts,
		modelId,
		skipped: false,
		railsPayload: null,
	};
}

/**
 * Enqueue an item onto the live scrub rails by emitting
 * `PII_SCRUB_REQUESTED`. The `PiiScrubService` drains this on its priority
 * BatchQueue: tier-0 → escalation → marker, with retry and crash-resume.
 *
 * This is the production trigger that makes the scrub reachable from a live
 * run. Call it from memory ingestion, document indexing, or conversation
 * persistence after mining candidates. The service owns the WHEN; this owns
 * the WHAT (content + candidates + context pack).
 */
export async function enqueuePiiScrub(
	runtime: IAgentRuntime,
	item: PiiScrubPipelineItem,
	options: PiiScrubPipelineOptions,
): Promise<void> {
	const result = await runPiiScrubPipeline(runtime, item, {
		...options,
		applyWriteBack: false,
	});
	if (result.skipped || !result.railsPayload) {
		return;
	}

	await runtime.emitEvent(EventType.PII_SCRUB_REQUESTED, {
		runtime,
		...result.railsPayload,
	});
}

/**
 * Mine candidate spans from text using the deterministic tier-0 detectors.
 * This is the production candidate-mining step for structured PII: emails,
 * phone numbers, credit cards, SSNs, etc. The context pack + model seam handle
 * the unstructured residue (names, orgs in ambiguous context).
 *
 * Returns the surface forms of detected PII, ready to feed as
 * `PiiScrubCandidate[]` into the pipeline.
 */
export function mineTier0Candidates(text: string): PiiScrubCandidate[] {
	const matches = detectPii(text);
	return matches.map((match) => ({
		surfaceForm: match.value,
		kind: match.kind,
		span: { start: match.start, end: match.end },
	}));
}
