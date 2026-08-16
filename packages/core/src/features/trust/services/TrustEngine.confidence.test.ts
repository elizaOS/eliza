/**
 * Deterministically verifies TrustEngine confidence scoring distinguishes
 * evidence agreement from trust direction. The private calculation is probed
 * directly so persistence, wall-clock history, and database adapters are not
 * part of the arithmetic contract under test.
 */

import { describe, expect, it } from "vitest";
import type { UUID } from "../../../types/index.ts";
import { type TrustEvidence, TrustEvidenceType } from "../types/trust.ts";
import { TrustEngine } from "./TrustEngine.ts";

type TrustConfidenceProbe = {
	calculateConfidence: (evidence: TrustEvidence[]) => number;
};

const EVALUATOR_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const SUBJECT_ID = "00000000-0000-0000-0000-000000000002" as UUID;

function evidence(impact: number, index: number): TrustEvidence {
	return {
		type:
			impact > 0
				? TrustEvidenceType.PROMISE_KEPT
				: TrustEvidenceType.PROMISE_BROKEN,
		timestamp: Date.now() - index,
		impact,
		weight: 1,
		description: `Evidence ${index}`,
		reportedBy: EVALUATOR_ID,
		verified: true,
		context: { evaluatorId: EVALUATOR_ID },
		targetEntityId: SUBJECT_ID,
		evaluatorId: EVALUATOR_ID,
	};
}

function confidence(impacts: number[]): number {
	const engine = new TrustEngine() as unknown as TrustConfidenceProbe;
	return engine.calculateConfidence(
		impacts.map((impact, index) => evidence(impact, index)),
	);
}

describe("TrustEngine evidence confidence", () => {
	it("scores unanimous evidence equally regardless of trust direction", () => {
		expect(confidence(Array(10).fill(10))).toBeCloseTo(0.8);
		expect(confidence(Array(10).fill(-10))).toBeCloseTo(0.8);
	});

	it("scores balanced contradictory evidence below unanimous evidence", () => {
		const mixed = confidence([...Array(5).fill(10), ...Array(5).fill(-10)]);
		const unanimous = confidence(Array(10).fill(10));

		expect(mixed).toBeCloseTo(0.5);
		expect(unanimous).toBeCloseTo(0.8);
		expect(unanimous).toBeGreaterThan(mixed);
	});

	it("keeps confidence at zero below the configured evidence minimum", () => {
		expect(confidence([10, 10])).toBe(0);
	});
});
