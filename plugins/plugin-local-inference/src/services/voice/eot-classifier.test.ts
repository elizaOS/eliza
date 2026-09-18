/**
 * Tests real probability normalization and turn-signal mapping, including decision
 * boundaries, invalid scores, and preservation of caller telemetry.
 */

import { describe, expect, it } from "vitest";
import {
	clampProbability,
	EOT_MID_CLAUSE_THRESHOLD,
	EOT_TENTATIVE_THRESHOLD,
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

	it.each([
		[Number.NaN, 0.5, "unknown"],
		[-1, 0, "user"],
		[9.5, 1, "agent"],
	] as const)(
		"normalizes %s into a %s probability for %s",
		(input, expected, speaker) => {
			const sig = turnSignalFromProbability({
				...base,
				probability: input,
			});
			expect(sig.endOfTurnProbability).toBe(expected);
			expect(sig.nextSpeaker).toBe(speaker);
		},
	);

	it("passes transcript through and includes model/latency only when supplied", () => {
		const withOpts = turnSignalFromProbability({
			...base,
			probability: 0.9,
			model: "eot-v2",
			latencyMs: 12,
		});
		expect(withOpts.transcript).toBe("are we done");
		expect(withOpts.source).toBe(base.source);
		expect(withOpts.model).toBe("eot-v2");
		expect(withOpts.latencyMs).toBe(12);

		const without = turnSignalFromProbability({ ...base, probability: 0.9 });
		expect("model" in without).toBe(false);
		expect("latencyMs" in without).toBe(false);
	});
});
