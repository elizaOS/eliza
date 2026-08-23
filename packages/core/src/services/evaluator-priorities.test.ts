/**
 * Unit coverage for canonical evaluator priorities in evaluator-priorities.ts.
 *
 * Tests priority value constants, relative ordering across functional evaluator
 * groups (form < inbound capture < reflection < memory < experience < skill),
 * and numeric positivity.
 */

import { describe, expect, it } from "vitest";
import { EvaluatorPriority } from "./evaluator-priorities.js";

describe("evaluator-priorities", () => {
	it("defines positive numeric priorities for all evaluator stages", () => {
		for (const [name, priority] of Object.entries(EvaluatorPriority)) {
			expect(typeof priority).toBe("number");
			expect(priority).toBeGreaterThan(0);
			expect(Number.isFinite(priority)).toBe(true);
			void name;
		}
	});

	it("enforces stage ordering: FORM precedes inbound captures and reflection", () => {
		expect(EvaluatorPriority.FORM).toBeLessThan(
			EvaluatorPriority.INBOUND_ATTACHMENT_IMAGE,
		);
		expect(EvaluatorPriority.INBOUND_ATTACHMENT_IMAGE).toBeLessThan(
			EvaluatorPriority.INBOUND_LINK_EXTRACTION,
		);
		expect(EvaluatorPriority.INBOUND_LINK_EXTRACTION).toBeLessThan(
			EvaluatorPriority.REFLECTION_FACTS,
		);
	});

	it("enforces reflection pipeline dependency ordering (facts < preferences < relationships < identity < success)", () => {
		expect(EvaluatorPriority.REFLECTION_FACTS).toBeLessThan(
			EvaluatorPriority.REFLECTION_PREFERENCES,
		);
		expect(EvaluatorPriority.REFLECTION_PREFERENCES).toBeLessThan(
			EvaluatorPriority.REFLECTION_RELATIONSHIPS,
		);
		expect(EvaluatorPriority.REFLECTION_RELATIONSHIPS).toBeLessThan(
			EvaluatorPriority.REFLECTION_IDENTITY,
		);
		expect(EvaluatorPriority.REFLECTION_IDENTITY).toBeLessThan(
			EvaluatorPriority.REFLECTION_SUCCESS,
		);
	});

	it("enforces memory and skill ordering (memory < experience < skill refinement)", () => {
		expect(EvaluatorPriority.REFLECTION_SUCCESS).toBeLessThan(
			EvaluatorPriority.MEMORY_SUMMARY,
		);
		expect(EvaluatorPriority.MEMORY_SUMMARY).toBeLessThan(
			EvaluatorPriority.MEMORY_LONG_TERM,
		);
		expect(EvaluatorPriority.MEMORY_LONG_TERM).toBeLessThan(
			EvaluatorPriority.EXPERIENCE,
		);
		expect(EvaluatorPriority.EXPERIENCE).toBeLessThan(
			EvaluatorPriority.SKILL_PROPOSAL,
		);
		expect(EvaluatorPriority.SKILL_PROPOSAL).toBeLessThan(
			EvaluatorPriority.SKILL_REFINEMENT,
		);
	});
});
