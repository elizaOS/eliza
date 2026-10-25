/**
 * Runs deterministic PII detection before escalating unresolved spans through the registered
 * PII_SCRUB model. Fully covered content needs no model call. Invalid, uninspectable, or
 * failed model results throw; missing replacements, mismatched rulesets, and invented span
 * verdicts never certify content as clean.
 */

import type {
	LocalInferencePriority,
	PiiPseudonymAssignment,
	PiiScrubParams,
	PiiScrubResult,
	PiiScrubVerdict,
} from "../types/model.js";
import { ModelType } from "../types/model.js";
import type { IAgentRuntime } from "../types/runtime.js";
import { detectPii, type PiiMatch } from "./pii-detectors.js";

/**
 * Thrown when a {@link PiiScrubResult} is structurally invalid — the seam's
 * fail-closed tripwire. A model handler returning a malformed "clean" result
 * (or a result that does not correspond to the requested text) is a fabrication
 * attempt from the pipeline's point of view; we throw rather than trust it, so
 * unscrubbed content can never fail-open onto an export surface.
 */
export class PiiScrubFabricationError extends Error {
	constructor(message: string) {
		super(`PII scrub result rejected (fail-closed): ${message}`);
		this.name = "PiiScrubFabricationError";
	}
}

/**
 * A single tier-0 decision: the deterministic detectors matched this span, so
 * it is PII and is redacted with a deterministic placeholder — no model call.
 */
export interface Tier0Span {
	/** The matched sensitive substring. */
	readonly span: string;
	/** Detector class (`credit-card`, `email`, `ssn`, …). */
	readonly kind: string;
	/** Start offset in the source text. */
	readonly start: number;
	/** End offset in the source text. */
	readonly end: number;
}

/** Outcome of {@link scrubWithEscalation}. */
export interface ScrubEscalationResult {
	/** Deterministic tier-0 spans (redacted without any model call). */
	readonly tier0: readonly Tier0Span[];
	/**
	 * The model verdicts for the escalated residue, or `null` when the model was
	 * never called (tier-0 fully covered the content OR there was no residue to
	 * escalate). `null` is the *positive* "no escalation needed" signal — it is
	 * never used to mean "assume clean" for un-inspected text.
	 */
	readonly escalation: PiiScrubResult | null;
	/** True when the model seam was invoked (residue existed and was escalated). */
	readonly escalated: boolean;
}

/**
 * Candidate residue extractor. The deterministic detectors handle *structured*
 * PII (cards, SSNs, keys, addresses). Everything the pipeline still wants a
 * model to judge (names/orgs in ambiguous context, gray-area rewrites) is
 * surfaced by the caller as `candidateSpans`. Only candidates NOT already
 * covered by a tier-0 span are escalated — so a value the deterministic layer
 * already caught never costs a model call.
 */
export interface ScrubEscalationRequest {
	/** The text being scrubbed. */
	readonly text: string;
	/**
	 * Model-judgment candidates the caller mined (e.g. from the entity
	 * recognizer). Spans already covered by a tier-0 detection are dropped before
	 * any model call. When empty, the model is never invoked.
	 */
	readonly candidateSpans: readonly string[];
	/** Active ruleset version (threaded into the model call + result check). */
	readonly rulesetVersion: string;
	/** Optional retrieval context for the model. Never the secret vault. */
	readonly contextPack?: string;
	/** Per-chunk cluster→surrogate slice (never the whole map). */
	readonly pseudonymAssignments?: readonly PiiPseudonymAssignment[];
	/**
	 * Local-lane scheduling priority. Defaults to `"background"` — the scrub is
	 * deferred autonomous work and must never preempt an interactive turn.
	 */
	readonly priority?: LocalInferencePriority;
	/** Per-request cancellation. */
	readonly signal?: AbortSignal;
	/** Detector kinds to skip in tier-0 (forwarded to {@link detectPii}). */
	readonly disabledKinds?: ReadonlySet<string>;
}

function toTier0(matches: readonly PiiMatch[]): Tier0Span[] {
	return matches.map((m) => ({
		span: m.value,
		kind: m.kind,
		start: m.start,
		end: m.end,
	}));
}

/**
 * True when `candidate` is already covered by a deterministic tier-0 match —
 * either the same value or a substring contained inside a matched value. Such a
 * candidate is a redundant escalation and is dropped. Blank candidates carry
 * nothing to judge and count as covered.
 */
function coveredByTier0(
	candidate: string,
	tier0Values: readonly string[],
): boolean {
	const needle = candidate.trim();
	if (needle.length === 0) return true;
	for (const value of tier0Values) {
		if (value === needle || value.includes(needle)) return true;
	}
	return false;
}

/** Candidates split by whether the deterministic tier-0 floor already covers them. */
export interface ScrubCandidatePartition {
	/** Candidates equal to, or contained in, a tier-0 match (never escalated). */
	readonly covered: readonly string[];
	/** Candidates that still require model judgment. */
	readonly residue: readonly string[];
}

/**
 * Split model-judgment candidates into tier-0-covered and residue using the
 * seam's containment rule. Every lane (local seam, cloud executor) uses this so
 * the "no escalation needed" decision cannot drift between them.
 */
export function partitionScrubCandidates(
	candidates: readonly string[],
	tier0Values: readonly string[],
): ScrubCandidatePartition {
	const covered: string[] = [];
	const residue: string[] = [];
	for (const candidate of candidates) {
		(coveredByTier0(candidate, tier0Values) ? covered : residue).push(
			candidate,
		);
	}
	return { covered, residue };
}

/**
 * Run the deterministic tier-0 detectors, then escalate ONLY the residue
 * candidates to the `PII_SCRUB` model. Fail-closed throughout:
 *
 * - No `PII_SCRUB` handler registered but there IS residue to judge → throws.
 * (We must never silently pass un-inspected candidates as clean.)
 * - The model handler throws → the error propagates (item failed-for-retry).
 * - The model returns a structurally-invalid result → {@link assertValidScrubResult}
 * throws {@link PiiScrubFabricationError}.
 *
 * The only path that returns without a model verdict is when there is genuinely
 * nothing to escalate (`escalation: null, escalated: false`) — an explicit,
 * auditable "tier-0 covered everything", not an assumption.
 */
export async function scrubWithEscalation(
	runtime: IAgentRuntime,
	request: ScrubEscalationRequest,
): Promise<ScrubEscalationResult> {
	const tier0 = toTier0(
		detectPii(request.text, { disabledKinds: request.disabledKinds }),
	);

	const { residue } = partitionScrubCandidates(
		request.candidateSpans,
		tier0.map((span) => span.span),
	);

	// Tier-0 short-circuit: nothing the model needs to judge → zero model calls.
	if (residue.length === 0) {
		return { tier0, escalation: null, escalated: false };
	}

	// There IS residue. A missing handler is fail-closed: we cannot judge it, so
	// we cannot declare it clean — throw so the caller quarantines the item.
	const handler = runtime.getModel(ModelType.PII_SCRUB);
	if (!handler) {
		throw new PiiScrubFabricationError(
			`no PII_SCRUB model registered but ${residue.length} candidate span(s) require escalation; refusing to pass un-inspected content`,
		);
	}

	const params: PiiScrubParams = {
		text: request.text,
		candidateSpans: residue,
		contextPack: request.contextPack,
		pseudonymAssignments: request.pseudonymAssignments,
		rulesetVersion: request.rulesetVersion,
		priority: request.priority ?? "background",
		signal: request.signal,
	};

	// A handler failure MUST propagate — never caught-and-defaulted to clean.
	const result = await runtime.useModel(ModelType.PII_SCRUB, params);

	// Structural fail-closed check: reject a fabricated/mismatched "all clear".
	assertValidScrubResult(result, {
		rulesetVersion: request.rulesetVersion,
		text: request.text,
		requiredSpans: residue,
	});

	return { tier0, escalation: result, escalated: true };
}

/** Options controlling {@link assertValidScrubResult}'s structural checks. */
export interface ScrubResultAssertionOptions {
	/** The ruleset version the result MUST have been produced under. */
	readonly rulesetVersion: string;
	/** The source text; every verdict span must be a substring of it. */
	readonly text: string;
	/**
	 * The candidate spans that were escalated. Every one MUST receive a verdict —
	 * a result that silently omits a requested span is a fail-open and is
	 * rejected. Omit to skip the coverage check (e.g. handler-level unit tests).
	 */
	readonly requiredSpans?: readonly string[];
}

/**
 * Structural fail-closed validator for a {@link PiiScrubResult}. Throws
 * {@link PiiScrubFabricationError} unless the result is a well-formed, auditable
 * verdict set for the requested text:
 *
 * - `modelId` is a non-empty string (audit trail).
 * - `rulesetVersion` matches the version the call was made under (a stale-ruleset
 * verdict must not be trusted as current).
 * - `verdicts` is an array; each verdict's `span` is a non-empty substring of
 * the source `text` (a verdict for a span not in the text is a fabrication).
 * - every `pii` verdict carries a non-empty `replacement` (a `pii` verdict with
 * no replacement would leave the real value in place — fail-open).
 * - `safe` verdicts carry NO `replacement` (a `safe` verdict is a positive
 * "clean" judgment, not a redaction).
 * - when `requiredSpans` is given, every required span receives a verdict (the
 * handler cannot silently drop a candidate and have it treated as clean).
 *
 * This is the tripwire that turns "the model returned something" into "the model
 * returned something we can *prove* is a real inspection result".
 */
export function assertValidScrubResult(
	result: unknown,
	options: ScrubResultAssertionOptions,
): asserts result is PiiScrubResult {
	if (result === null || typeof result !== "object") {
		throw new PiiScrubFabricationError("result is not an object");
	}
	const r = result as Partial<PiiScrubResult>;

	if (typeof r.modelId !== "string" || r.modelId.length === 0) {
		throw new PiiScrubFabricationError("missing or empty modelId");
	}
	if (r.rulesetVersion !== options.rulesetVersion) {
		throw new PiiScrubFabricationError(
			`ruleset version mismatch: expected ${JSON.stringify(
				options.rulesetVersion,
			)}, got ${JSON.stringify(r.rulesetVersion)}`,
		);
	}
	if (!Array.isArray(r.verdicts)) {
		throw new PiiScrubFabricationError("verdicts is not an array");
	}

	const seenSpans = new Set<string>();
	for (const verdict of r.verdicts as readonly PiiScrubVerdict[]) {
		if (verdict === null || typeof verdict !== "object") {
			throw new PiiScrubFabricationError("verdict is not an object");
		}
		if (typeof verdict.span !== "string" || verdict.span.length === 0) {
			throw new PiiScrubFabricationError("verdict has missing or empty span");
		}
		if (!options.text.includes(verdict.span)) {
			throw new PiiScrubFabricationError(
				`verdict span ${JSON.stringify(
					verdict.span,
				)} is not present in the source text`,
			);
		}
		if (verdict.kind === "pii") {
			if (
				typeof verdict.replacement !== "string" ||
				verdict.replacement.length === 0
			) {
				throw new PiiScrubFabricationError(
					`pii verdict for ${JSON.stringify(
						verdict.span,
					)} is missing a replacement`,
				);
			}
		} else if (verdict.kind === "safe") {
			if (verdict.replacement !== undefined) {
				throw new PiiScrubFabricationError(
					`safe verdict for ${JSON.stringify(
						verdict.span,
					)} must not carry a replacement`,
				);
			}
		} else {
			throw new PiiScrubFabricationError(
				`verdict has unknown kind ${JSON.stringify(
					(verdict as { kind?: unknown }).kind,
				)}`,
			);
		}
		seenSpans.add(verdict.span);
	}

	if (options.requiredSpans) {
		for (const required of options.requiredSpans) {
			const needle = required.trim();
			if (needle.length === 0) continue;
			// A required span is covered if some verdict span equals it or contains
			// it (the model may return a wider span that subsumes the candidate).
			const covered = [...seenSpans].some(
				(s) => s === needle || s.includes(needle),
			);
			if (!covered) {
				throw new PiiScrubFabricationError(
					`escalated candidate ${JSON.stringify(
						required,
					)} received no verdict (fail-open dropped candidate)`,
				);
			}
		}
	}
}
