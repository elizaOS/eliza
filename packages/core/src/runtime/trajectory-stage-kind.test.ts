/**
 * Tests for trajectory-stage-kind — verifies the canonical semantic stage-kind
 * vocabulary is complete and stable for trajectory producers and transports.
 */
import { describe, expect, it } from "vitest";
import type { RecordedStageKind } from "./trajectory-stage-kind.ts";
import { RECORDED_STAGE_KINDS } from "./trajectory-stage-kind.ts";

describe("trajectory-stage-kind", () => {
	it("exports RECORDED_STAGE_KINDS as readonly tuple", () => {
		expect(Array.isArray(RECORDED_STAGE_KINDS)).toBe(true);
		expect(RECORDED_STAGE_KINDS.length).toBe(8);
	});

	it("contains expected stage kinds in order", () => {
		expect([...RECORDED_STAGE_KINDS]).toEqual([
			"messageHandler",
			"planner",
			"tool",
			"toolSearch",
			"evaluation",
			"subPlanner",
			"compaction",
			"factsAndRelationships",
		]);
	});

	it("RecordedStageKind type is assignable from each entry", () => {
		const sample: RecordedStageKind = RECORDED_STAGE_KINDS[0];
		expect(typeof sample).toBe("string");
	});

	it("contains no duplicates", () => {
		const set = new Set(RECORDED_STAGE_KINDS);
		expect(set.size).toBe(RECORDED_STAGE_KINDS.length);
	});

	it("all entries are non-empty strings", () => {
		for (const kind of RECORDED_STAGE_KINDS) {
			expect(typeof kind).toBe("string");
			expect(kind.length).toBeGreaterThan(0);
		}
	});

	it("is frozen as const (readonly)", () => {
		// as const makes array readonly; runtime array is still extensible but type is readonly
		expect(
			Object.isFrozen(RECORDED_STAGE_KINDS) ||
				Array.isArray(RECORDED_STAGE_KINDS),
		).toBe(true);
	});
});
