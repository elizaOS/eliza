/**
 * Contract tests for the canonical recorded stage-kind vocabulary shared by
 * trajectory producers and transports. Deterministic — pure module import,
 * no runtime, no mocks.
 */
import { describe, expect, it } from "vitest";
import { RECORDED_STAGE_KINDS } from "./trajectory-stage-kind.ts";

describe("RECORDED_STAGE_KINDS", () => {
	it("exposes the canonical vocabulary in producer order", () => {
		expect(RECORDED_STAGE_KINDS).toEqual([
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

	it("is a plain array of exactly eight entries", () => {
		expect(Array.isArray(RECORDED_STAGE_KINDS)).toBe(true);
		expect(RECORDED_STAGE_KINDS).toHaveLength(8);
	});

	it("holds unique kinds so set-backed membership stays unambiguous", () => {
		expect(new Set(RECORDED_STAGE_KINDS).size).toBe(
			RECORDED_STAGE_KINDS.length,
		);
	});

	it("holds only non-empty, unpadded string kinds", () => {
		for (const kind of RECORDED_STAGE_KINDS) {
			expect(typeof kind).toBe("string");
			expect(kind.length).toBeGreaterThan(0);
			expect(kind).toBe(kind.trim());
		}
	});

	it("admits every declared kind under exact-match membership", () => {
		const members = new Set<string>(RECORDED_STAGE_KINDS);
		for (const kind of RECORDED_STAGE_KINDS) {
			expect(members.has(kind)).toBe(true);
		}
	});

	it("rejects unknown, mutated, and empty kinds under exact-match membership", () => {
		const members = new Set<string>(RECORDED_STAGE_KINDS);
		for (const kind of RECORDED_STAGE_KINDS) {
			expect(members.has(`${kind}!`)).toBe(false);
			expect(members.has(kind.toUpperCase())).toBe(false);
		}
		expect(members.has("unknown")).toBe(false);
		expect(members.has("")).toBe(false);
	});
});
