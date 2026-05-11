/**
 * @fileoverview Verdict combiner.
 *
 * Rules (in order of application):
 *  1. If any layer reports FAIL with confidence ≥ 0.9, the combined verdict is
 *     FAIL. Hard-fail signals (phrase regex matches like "are you sure")
 *     dominate noisy LLM agreement.
 *  2. If any layer reports NEEDS_REVIEW, the combined verdict is NEEDS_REVIEW —
 *     unless every other layer is PASS and the review signal has confidence
 *     ≤ 0.3 (then it is allowed to be PASS, but `highConfidencePass` is false).
 *  3. Otherwise, take the majority verdict across layers with confidence
 *     weight. Ties or absent layers collapse to NEEDS_REVIEW.
 *  4. Strict mode (`options.strict = true`) flips ambiguous NEEDS_REVIEW
 *     outcomes to FAIL — used only by callers who explicitly opt in.
 */

import type {
	LayerResult,
	PersonalityVerdict,
	Verdict,
	PersonalityScenario,
} from "../types.ts";

function weightedVote(layers: LayerResult[]): { verdict: Verdict; weight: number } {
	const tally: Record<Verdict, number> = { PASS: 0, FAIL: 0, NEEDS_REVIEW: 0 };
	for (const l of layers) {
		tally[l.verdict] += Math.max(l.confidence, 0.01);
	}
	const entries = Object.entries(tally) as Array<[Verdict, number]>;
	entries.sort((a, b) => b[1] - a[1]);
	const top = entries[0];
	const second = entries[1];
	if (!top) return { verdict: "NEEDS_REVIEW", weight: 0 };
	const topPair = top;
	const secondPair = second;
	if (secondPair && topPair[1] - secondPair[1] < 0.2) {
		return { verdict: "NEEDS_REVIEW", weight: topPair[1] };
	}
	return { verdict: topPair[0], weight: topPair[1] };
}

export function combineVerdict(
	scenario: PersonalityScenario,
	layers: LayerResult[],
	strict: boolean,
): PersonalityVerdict {
	const active = layers.filter(
		(l) => !(l.verdict === "NEEDS_REVIEW" && l.confidence === 0),
	);

	// 1. Hard-fail signal.
	const hardFail = active.find(
		(l) => l.verdict === "FAIL" && l.confidence >= 0.9,
	);
	if (hardFail) {
		return finalize({
			scenario,
			verdict: "FAIL",
			layers,
			reason: `hard fail: ${hardFail.layer} — ${hardFail.reason}`,
			highConfidencePass: false,
		});
	}

	// 2. Strong NEEDS_REVIEW from any active layer.
	const strongReview = active.find(
		(l) => l.verdict === "NEEDS_REVIEW" && l.confidence > 0.3,
	);
	if (strongReview) {
		const verdict: Verdict = strict ? "FAIL" : "NEEDS_REVIEW";
		return finalize({
			scenario,
			verdict,
			layers,
			reason: `needs review: ${strongReview.layer} — ${strongReview.reason}`,
			highConfidencePass: false,
		});
	}

	// 3. Weighted vote across remaining layers (drop the very-low-confidence
	// NEEDS_REVIEW signals so a skipped embedder doesn't drown the vote).
	const voted = weightedVote(
		active.filter((l) => !(l.verdict === "NEEDS_REVIEW" && l.confidence <= 0.3)),
	);

	if (voted.verdict === "PASS") {
		const allPass = active.every((l) =>
			l.verdict === "PASS" || (l.verdict === "NEEDS_REVIEW" && l.confidence <= 0.3),
		);
		const passConfidences = active
			.filter((l) => l.verdict === "PASS")
			.map((l) => l.confidence);
		const minPassConfidence = passConfidences.length > 0
			? Math.min(...passConfidences)
			: 0;
		const highConfidencePass = allPass && minPassConfidence >= 0.85;
		return finalize({
			scenario,
			verdict: "PASS",
			layers,
			reason: `pass (weight ${voted.weight.toFixed(2)})`,
			highConfidencePass,
		});
	}

	if (voted.verdict === "FAIL") {
		return finalize({
			scenario,
			verdict: "FAIL",
			layers,
			reason: `fail (weight ${voted.weight.toFixed(2)})`,
			highConfidencePass: false,
		});
	}

	const verdict: Verdict = strict ? "FAIL" : "NEEDS_REVIEW";
	return finalize({
		scenario,
		verdict,
		layers,
		reason: `inconclusive (weight ${voted.weight.toFixed(2)})`,
		highConfidencePass: false,
	});
}

function finalize(args: {
	scenario: PersonalityScenario;
	verdict: Verdict;
	layers: LayerResult[];
	reason: string;
	highConfidencePass: boolean;
}): PersonalityVerdict {
	return {
		scenarioId: args.scenario.id,
		bucket: args.scenario.bucket,
		verdict: args.verdict,
		layers: args.layers,
		reason: args.reason,
		highConfidencePass: args.highConfidencePass,
	};
}
