// Coverage for the pure end-of-turn decision helpers (#9147, "eot" matrix
// class). turnSignalFromProbability maps an EOT probability onto the
// agent/user/unknown next-speaker decision via the commit/tentative thresholds;
// these boundaries gate whether the agent speaks, so they are pinned here.

import { describe, expect, it } from "vitest";
import {
	clampProbability,
	EOT_MID_CLAUSE_THRESHOLD,
	EOT_TENTATIVE_THRESHOLD,
	LIVEKIT_TURN_DETECTOR_EN_REVISION,
	LIVEKIT_TURN_DETECTOR_INTL_REVISION,
	turnDetectorRevisionForTier,
	turnSignalFromProbability,
} from "./eot-classifier";

describe("clampProbability", () => {
	it("clamps to [0,1] and defaults non-finite input to 0.5", () => {
		expect(clampProbability(-1)).toBe(0);
		expect(clampProbability(2)).toBe(1);
		expect(clampProbability(0.7)).toBe(0.7);
		expect(clampProbability(Number.NaN)).toBe(0.5);
		expect(clampProbability(Number.POSITIVE_INFINITY)).toBe(0.5);
	});
});

describe("turnSignalFromProbability", () => {
	const base = { transcript: "are we done", source: "heuristic" as const };

	it("yields agent (speak) at/above the tentative threshold", () => {
		const sig = turnSignalFromProbability({
			...base,
			probability: EOT_TENTATIVE_THRESHOLD,
		});
		expect(sig.nextSpeaker).toBe("agent");
		expect(sig.agentShouldSpeak).toBe(true);
	});

	it("yields user (stay silent) below the mid-clause threshold", () => {
		const sig = turnSignalFromProbability({
			...base,
			probability: EOT_MID_CLAUSE_THRESHOLD - 0.01,
		});
		expect(sig.nextSpeaker).toBe("user");
		expect(sig.agentShouldSpeak).toBe(false);
	});

	it("yields unknown (null) in the mid-clause band", () => {
		const sig = turnSignalFromProbability({
			...base,
			probability: EOT_MID_CLAUSE_THRESHOLD,
		});
		expect(sig.nextSpeaker).toBe("unknown");
		expect(sig.agentShouldSpeak).toBeNull();
	});

	it("clamps a non-finite probability into the unknown band", () => {
		const sig = turnSignalFromProbability({
			...base,
			probability: Number.NaN,
		});
		expect(sig.endOfTurnProbability).toBe(0.5);
		expect(sig.nextSpeaker).toBe("unknown");
	});

	it("passes transcript through and includes model/latency only when supplied", () => {
		const withOpts = turnSignalFromProbability({
			...base,
			probability: 0.9,
			model: "eot-v2",
			latencyMs: 12,
		});
		expect(withOpts.transcript).toBe("are we done");
		expect(withOpts.model).toBe("eot-v2");
		expect(withOpts.latencyMs).toBe(12);

		const without = turnSignalFromProbability({ ...base, probability: 0.9 });
		expect("model" in without).toBe(false);
		expect("latencyMs" in without).toBe(false);
	});
});

describe("turnDetectorRevisionForTier", () => {
	it("maps the 2b entry tier to the English variant, others to multilingual", () => {
		expect(turnDetectorRevisionForTier("2b")).toBe(
			LIVEKIT_TURN_DETECTOR_EN_REVISION,
		);
		expect(turnDetectorRevisionForTier("eliza-1-2b")).toBe(
			LIVEKIT_TURN_DETECTOR_EN_REVISION,
		);
		expect(turnDetectorRevisionForTier("4b")).toBe(
			LIVEKIT_TURN_DETECTOR_INTL_REVISION,
		);
		expect(turnDetectorRevisionForTier("eliza-1-8b")).toBe(
			LIVEKIT_TURN_DETECTOR_INTL_REVISION,
		);
	});
});
