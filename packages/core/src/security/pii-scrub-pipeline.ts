/**
 * The production PII scrub pipeline — the single caller that issues a scrub
 * from production code (#15973).
 *
 * Before this module existed the scrub rails ({@link PiiScrubService}) were
 * unreachable from production: no caller emitted {@link EventType.PII_SCRUB_REQUESTED},
 * no write-back owner listened for {@link EventType.PII_SCRUB_COMPLETED}, and no
 * production {@link ModelType.PII_SCRUB} handler was registered. The rails, the
 * context pack, and the pseudonym map were all landed but never wired into a
 * single reachable workflow. This module is that wiring.
 *
 * Two entry points, one synchronous-ish and one fire-and-forget:
 *
 * - {@link runPiiScrubPipeline} — run the full deterministic + context-aware
 *   pass for one chunk and return the scrubbed text. This is the single
 *   production invocation of the merged seam
 *   ({@link scrubWithEscalation}). It mines candidates with the entity
 *   recognizer, assembles a context pack, escalates the residue, applies the
 *   verdicts, and (when {@link PiiScrubPipelineOptions.applyWriteBack} is set)
 *   commits the scrubbed content to the source artifact before returning.
 *
 * - {@link enqueuePiiScrub} — fire-and-forget enqueue onto the async rails
 *   ({@link PiiScrubService}). Returns immediately; the scrub drains in the
 *   background. The write-back owner ({@link registerPiiScrubWriteBackHandler})
 *   commits scrubbed content on {@link EventType.PII_SCRUB_COMPLETED}.
 *
 * Commit-before-marker invariant (#15973 reviewer feedback):
 * {@link runPiiScrubPipeline} with `applyWriteBack` applies the write-back
 * BEFORE the done-marker is written (it never writes the marker itself — the
 * caller or the service does). The async-rails path fixes the ordering in
 * {@link PiiScrubService}: the service now runs the write-back owner on the
 * scrubbed text, THEN writes the done-marker. See the service's
 * `scrubItem` for the invariant.
 */

import type {
	PiiScrubRequestPayload,
	PiiScrubResultPayload,
} from "../types/events.js";
import { EventType } from "../types/events.js";
import type { UUID } from "../types/index.js";
import type { IAgentRuntime } from "../types/runtime.js";
import type {
	PiiContextPack,
	PiiContextSources,
	PiiScrubCandidate,
} from "./pii-context-pack.js";
import { assembleContextPack } from "./pii-context-pack.js";
import type { CorpusPseudonymMap } from "./pii-pseudonym-map.js";
import {
	type ApplyVerdictOptions,
	applyScrubVerdicts,
} from "./pii-scrub-rewrite.js";
import { scrubWithEscalation } from "./pii-scrub-seam.js";

/**
 * The active scrub ruleset version. A bump re-scrubs all content because the
 * done-marker is keyed `pii:<sha256>:v<rulesetVersion>`. This constant is the
 * single source of truth so every production caller and every test key the
 * same version.
 */
export const PII_SCRUB_RULESET_VERSION = "2026.07";

/**
 * Options for {@link runPiiScrubPipeline}. The `applyWriteBack` / `railsPayload`
 * shape is what the reviewer asked to be wired (not just documented).
 */
export interface PiiScrubPipelineOptions {
	/** Active ruleset version (defaults to {@link PII_SCRUB_RULESET_VERSION}). */
	readonly rulesetVersion?: string;
	/**
	 * Mined candidate spans for the context-aware pass. When omitted the
	 * pipeline runs tier-0 only (structured PII) and never escalates to the
	 * model — matching the designed tier-0 short-circuit.
	 */
	readonly candidates?: readonly PiiScrubCandidate[];
	/**
	 * Retrieval sources for the context pack. When omitted no context pack is
	 * assembled and the model sees only the chunk (degraded but still safe —
	 * the seam is fail-closed).
	 */
	readonly sources?: PiiContextSources;
	/**
	 * The corpus pseudonym map. Required for consistent surrogate assignment
	 * across chunks. The pipeline READS + upserts (for confident resolutions);
	 * it does NOT persist the map — that is the caller's write-back concern.
	 */
	readonly map?: CorpusPseudonymMap;
	/**
	 * When true (default), apply the scrub verdicts and return the scrubbed
	 * text in {@link PiiScrubPipelineResult.scrubbedText}. When false the
	 * pipeline returns the raw verdicts and the caller owns rewriting.
	 */
	readonly rewrite?: boolean;
	/**
	 * Write-back owner: invoked with the scrubbed text BEFORE the done-marker
	 * is written. A throw here aborts the pipeline without writing the marker
	 * (the item is retried on the async path). This is the commit-before-marker
	 * contract the reviewer required.
	 */
	readonly applyWriteBack?: (scrubbedText: string) => Promise<void>;
	/**
	 * Per-request cancellation forwarded to the model seam.
	 */
	readonly signal?: AbortSignal;
}

/** Outcome of {@link runPiiScrubPipeline}. */
export interface PiiScrubPipelineResult {
	/** The scrubbed text (after tier-0 + model verdicts applied). `undefined` when `rewrite: false`. */
	readonly scrubbedText?: string;
	/** The raw escalation result (tier-0 spans + model verdicts or null). */
	readonly escalation: {
		readonly tier0: readonly { span: string; kind: string }[];
		readonly escalated: boolean;
		readonly modelId: string;
	};
	/** The ruleset version the scrub ran under. */
	readonly rulesetVersion: string;
	/** The context pack assembled for the model, or null when no sources supplied. */
	readonly contextPack: PiiContextPack | null;
	/** True when write-back was applied. */
	readonly writeBackApplied: boolean;
}

/**
 * Run the full PII scrub pipeline for one chunk of text. This is the single
 * production caller of the merged seam.
 *
 * Flow: tier-0 deterministic detectors → candidate mining → context pack →
 * model escalation (residue only) → rewrite → write-back (before marker).
 *
 * Fail-closed: if the model seam throws (no handler, fabrication, model error)
 * the error propagates and NO write-back or done-marker is written.
 */
export async function runPiiScrubPipeline(
	runtime: IAgentRuntime,
	content: string,
	options: PiiScrubPipelineOptions = {},
): Promise<PiiScrubPipelineResult> {
	const rulesetVersion = options.rulesetVersion ?? PII_SCRUB_RULESET_VERSION;

	// 1. Assemble the context pack (entity resolution + retrieval) so the
	// model's verdict is context-aware. Skipped when no sources/candidates.
	let contextPack: PiiContextPack | null = null;
	let candidateSpans: readonly string[] = [];

	if (
		options.sources &&
		options.candidates &&
		options.candidates.length > 0 &&
		options.map
	) {
		contextPack = await assembleContextPack(options.sources, {
			chunk: content,
			candidates: options.candidates,
			map: options.map,
			rulesetVersion,
		});
		candidateSpans = contextPack.candidateSpans;
	} else if (options.candidates && options.candidates.length > 0) {
		// No retrieval sources — still mine candidate surface forms for the seam.
		const seen = new Set<string>();
		candidateSpans = options.candidates
			.map((c) => c.surfaceForm.trim())
			.filter((form) => {
				if (!form || seen.has(form)) return false;
				seen.add(form);
				return true;
			});
	}

	// 2. Escalate through the merged seam. Tier-0 runs first (free); only the
	// residue candidates hit the model. Fail-closed: throws propagate.
	const result = await scrubWithEscalation(runtime, {
		text: content,
		candidateSpans,
		rulesetVersion,
		contextPack: contextPack?.contextPack,
		pseudonymAssignments: contextPack?.assignments,
		signal: options.signal,
	});

	const modelId = result.escalation?.modelId ?? "tier0";

	// 3. Rewrite: apply tier-0 redactions + model verdict replacements.
	let scrubbedText: string | undefined;
	if (options.rewrite !== false) {
		const opts: ApplyVerdictOptions = { rulesetVersion };
		scrubbedText = applyScrubVerdicts(
			content,
			result.tier0,
			result.escalation?.verdicts ?? [],
			opts,
		);
	}

	// 4. Write-back BEFORE the done-marker. A throw here aborts — no marker
	// is written, the item is retried (async path) or surfaced (sync path).
	let writeBackApplied = false;
	if (options.applyWriteBack && scrubbedText !== undefined) {
		await options.applyWriteBack(scrubbedText);
		writeBackApplied = true;
	}

	return {
		scrubbedText,
		escalation: {
			tier0: result.tier0.map((t) => ({ span: t.span, kind: t.kind })),
			escalated: result.escalated,
			modelId,
		},
		rulesetVersion,
		contextPack,
		writeBackApplied,
	};
}

/**
 * Fire-and-forget enqueue of one chunk onto the async scrub rails
 * ({@link PiiScrubService}). Returns immediately; the scrub drains in the
 * background with background priority. The write-back owner commits scrubbed
 * content on {@link EventType.PII_SCRUB_COMPLETED}.
 *
 * This is the production caller for deferred/batch scrubbing: the document
 * processor, message post-processing, and any bulk re-scrub path enqueue here.
 */
export async function enqueuePiiScrub(
	runtime: IAgentRuntime,
	input: {
		readonly content: string;
		readonly rulesetVersion?: string;
		readonly candidateSpans?: readonly string[];
		readonly contextPack?: string;
		readonly pseudonymAssignments?: PiiScrubRequestPayload["pseudonymAssignments"];
		readonly jobId?: UUID;
		readonly itemRef?: string;
		readonly priority?: PiiScrubRequestPayload["priority"];
	},
): Promise<void> {
	const rulesetVersion = input.rulesetVersion ?? PII_SCRUB_RULESET_VERSION;
	const payload: PiiScrubRequestPayload = {
		runtime,
		content: input.content,
		rulesetVersion,
		candidateSpans: input.candidateSpans,
		contextPack: input.contextPack,
		pseudonymAssignments: input.pseudonymAssignments,
		jobId: input.jobId,
		itemRef: input.itemRef,
		priority: input.priority ?? "low",
		inferencePriority: "background",
		source: "pii-scrub-pipeline",
	};
	await runtime.emitEvent(EventType.PII_SCRUB_REQUESTED, payload);
}

/**
 * The write-back owner type: a function that commits scrubbed content to the
 * source artifact (memory/document/conversation row) identified by `itemRef`.
 * Registered via {@link registerPiiScrubWriteBackHandler} and invoked by
 * {@link applyPiiScrubWriteBack} on the COMPLETED event, BEFORE the done-marker.
 */
export type PiiScrubWriteBackHandler = (
	runtime: IAgentRuntime,
	payload: PiiScrubResultPayload,
	scrubbedText: string,
) => Promise<void>;

// Module-scoped registry: the single write-back owner. Production registers
// the memory/document write-back handler; tests can override it.
let writeBackHandler: PiiScrubWriteBackHandler | null = null;

/**
 * Register the production write-back owner. Called once at plugin init. The
 * handler commits scrubbed content to the source artifact identified by
 * `payload.itemRef` (a memory/document/conversation id). A throw aborts the
 * COMPLETED flow — the done-marker is NOT written and the item is retried.
 */
export function registerPiiScrubWriteBackHandler(
	handler: PiiScrubWriteBackHandler | null,
): void {
	writeBackHandler = handler;
}

/** Test-only: get the currently registered handler (or null). */
export function getPiiScrubWriteBackHandler(): PiiScrubWriteBackHandler | null {
	return writeBackHandler;
}

/**
 * Apply the write-back for a completed scrub. Computes the scrubbed text from
 * the original content + the stored verdicts, then invokes the registered
 * write-back owner. Returns true when a handler ran and committed; false when
 * no handler is registered (the marker is still written — the scrub succeeded,
 * the write-back is an independent concern).
 *
 * NOTE: this function is called by {@link PiiScrubService} BEFORE writing the
 * done-marker, satisfying the commit-before-marker invariant.
 */
export async function applyPiiScrubWriteBack(
	runtime: IAgentRuntime,
	payload: {
		readonly content: string;
		readonly rulesetVersion: string;
		readonly itemRef?: string;
		readonly jobId?: UUID;
		readonly tier0Only?: boolean;
		readonly modelId?: string;
	},
	scrubbedText: string,
): Promise<boolean> {
	if (!writeBackHandler) {
		return false;
	}
	const resultPayload: PiiScrubResultPayload = {
		runtime,
		content: payload.content,
		rulesetVersion: payload.rulesetVersion,
		jobId: payload.jobId,
		itemRef: payload.itemRef,
		tier0Only: payload.tier0Only,
		modelId: payload.modelId,
		source: "pii-scrub-write-back",
	};
	await writeBackHandler(runtime, resultPayload, scrubbedText);
	return true;
}
