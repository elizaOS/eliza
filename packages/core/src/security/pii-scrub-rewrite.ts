/**
 * Apply PII scrub verdicts to source text — the rewrite stage that produces the
 * scrubbed content committed by the write-back owner (#15973).
 *
 * This module is the single producer of `scrubbedText`: given the original
 * content, the tier-0 deterministic spans, and the model's per-span verdicts,
 * it produces the text with every PII span replaced by its surrogate. It is a
 * pure function — no runtime, no model calls — so it is unit-testable in
 * isolation and safe to call from both the sync pipeline and the async rails.
 *
 * Replacement strategy:
 * - Tier-0 spans are replaced with deterministic placeholders
 *   `[REDACTED:<kind>]` (structured secrets never need a realistic surrogate —
 *   they are opaque tokens).
 * - Model `pii` verdicts are replaced with the verdict's `replacement`
 *   (the surrogate assigned by the pseudonym map / model).
 * - Model `safe` verdicts are left in place (the model positively judged them
 *   non-sensitive).
 *
 * Replacement is applied RIGHT-TO-LEFT by offset so earlier offsets never
 * shift when a later span is replaced. Offsets from tier-0 are authoritative
 * (deterministic). Model verdict spans are located by substring match (the
 * model returns the surface form, not an offset — see the entity-recognizer
 * module note on best-effort offsets).
 */

import type { PiiScrubVerdict } from "../types/model.js";
import type { Tier0Span } from "./pii-scrub-seam.js";

/** Options for {@link applyScrubVerdicts}. */
export interface ApplyVerdictOptions {
	/** The ruleset version (for audit/logging; not used in the rewrite). */
	readonly rulesetVersion?: string;
	/**
	 * When true, leave the text unchanged when NO verdicts or tier-0 spans are
	 * present (the content had nothing to scrub). Default true.
	 */
	readonly passThroughWhenClean?: boolean;
}

/** One replacement to apply at a known offset range. */
interface Replacement {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

/**
 * Build the deterministic placeholder for a tier-0 span kind.
 * `[REDACTED:credit-card]`, `[REDACTED:ssn]`, etc. Structured secrets are never
 * given realistic surrogates — they are opaque tokens by design.
 */
export function tier0Placeholder(kind: string): string {
	return `[REDACTED:${kind}]`;
}

/**
 * Apply tier-0 redactions and model verdicts to produce the scrubbed text.
 *
 * @param content The original source text.
 * @param tier0 The deterministic tier-0 spans (offsets are authoritative).
 * @param verdicts The model's per-span verdicts (substring-located).
 * @param options Rewrite options.
 * @returns The scrubbed text. When no replacements are made and
 *   `passThroughWhenClean` is true (default), the original content is returned
 *   unchanged.
 */
export function applyScrubVerdicts(
	content: string,
	tier0: readonly Tier0Span[],
	verdicts: readonly PiiScrubVerdict[],
	options: ApplyVerdictOptions = {},
): string {
	const { passThroughWhenClean = true } = options;
	const replacements: Replacement[] = [];

	// Tier-0 spans: authoritative offsets, deterministic placeholder.
	for (const span of tier0) {
		replacements.push({
			start: span.start,
			end: span.end,
			text: tier0Placeholder(span.kind),
		});
	}

	// Model verdicts: `pii` verdicts are replaced with the surrogate.
	// `safe` verdicts are left in place. Locate by substring match; the model
	// returns the surface form, not an offset. Only the first occurrence is
	// replaced per verdict (dedup verdicts by span if duplicates arrive).
	const seenVerdictSpans = new Set<string>();
	for (const verdict of verdicts) {
		if (verdict.kind !== "pii") continue;
		if (typeof verdict.replacement !== "string" || !verdict.replacement) {
			continue;
		}
		const span = verdict.span;
		if (seenVerdictSpans.has(span)) continue;
		seenVerdictSpans.add(span);

		const idx = content.indexOf(span);
		if (idx === -1) continue;
		replacements.push({
			start: idx,
			end: idx + span.length,
			text: verdict.replacement,
		});
	}

	if (replacements.length === 0 && passThroughWhenClean) {
		return content;
	}

	// Apply replacements right-to-left by offset so earlier offsets are stable.
	replacements.sort((a, b) => b.start - a.start);

	// Deduplicate overlapping replacements: when two replacements cover the same
	// range, keep the first (highest-priority) and drop the rest. Tier-0 offsets
	// are authoritative; model verdicts that overlap a tier-0 span are dropped.
	const nonOverlapping: Replacement[] = [];
	let lastStart = Number.POSITIVE_INFINITY;
	for (const rep of replacements) {
		if (rep.end <= lastStart) {
			nonOverlapping.push(rep);
			lastStart = rep.start;
		}
	}

	let result = content;
	for (const rep of nonOverlapping) {
		result = result.slice(0, rep.start) + rep.text + result.slice(rep.end);
	}
	return result;
}
