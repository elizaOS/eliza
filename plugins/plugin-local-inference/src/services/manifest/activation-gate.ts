/**
 * Manifest-side view of the Eliza-1 activation gate. The predicate itself is
 * the catalog's `eliza1EvalsPassActivationGate`, so activation, the download
 * boundary, and the recommendation surfaces all decide eligibility with one
 * rule over the same `evals` block.
 */
import { eliza1EvalsPassActivationGate } from "../catalog";
import type { Eliza1Manifest } from "./types";

export function manifestPassesActivationGate(
	manifest: Eliza1Manifest,
): boolean {
	return eliza1EvalsPassActivationGate(manifest.evals);
}

/** Names of every eval gate the manifest reports as not passed. */
export function collectFailedEvalNames(manifest: Eliza1Manifest): string[] {
	const failed: string[] = [];
	const evals = manifest.evals;
	if (evals.textEval.passed !== true) failed.push("textEval");
	if (evals.voiceRtf.passed !== true) failed.push("voiceRtf");
	if (evals.e2eLoopOk !== true) failed.push("e2eLoopOk");
	if (evals.thirtyTurnOk !== true) failed.push("thirtyTurnOk");
	if (evals.asrWer && evals.asrWer.passed !== true) failed.push("asrWer");
	if (evals.embedMteb && evals.embedMteb.passed !== true) {
		failed.push("embedMteb");
	}
	if (evals.vadLatencyMs && evals.vadLatencyMs.passed !== true) {
		failed.push("vadLatencyMs");
	}
	if (evals.expressive && evals.expressive.passed !== true) {
		failed.push("expressive");
	}
	if (evals.turnDetector && evals.turnDetector.passed !== true) {
		failed.push("turnDetector");
	}
	return failed;
}
