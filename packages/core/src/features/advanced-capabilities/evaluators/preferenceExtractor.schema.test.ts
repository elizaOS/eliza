/**
 * Unit tests for preference extractor schema: validates trait enums,
 * discriminated union parsing, and tolerant output envelope parsing.
 */
import { describe, expect, it } from "vitest";
import {
	PreferenceOpSchema,
	PreferenceTraitEnum,
	parsePreferenceOutputTolerant,
} from "./preferenceExtractor.schema.ts";

describe("preferenceExtractor.schema", () => {
	describe("PreferenceTraitEnum", () => {
		it("accepts valid traits", () => {
			expect(PreferenceTraitEnum.safeParse("verbosity").success).toBe(true);
			expect(PreferenceTraitEnum.safeParse("tone").success).toBe(true);
			expect(PreferenceTraitEnum.safeParse("formality").success).toBe(true);
		});

		it("rejects unauthorized traits", () => {
			expect(PreferenceTraitEnum.safeParse("reply_gate").success).toBe(false);
			expect(PreferenceTraitEnum.safeParse("speed").success).toBe(false);
		});
	});

	describe("PreferenceOpSchema", () => {
		it("validates set_trait op", () => {
			const res = PreferenceOpSchema.safeParse({
				op: "set_trait",
				trait: "verbosity",
				value: "terse",
				confidence: 0.9,
				evidence: "user said be concise",
			});
			expect(res.success).toBe(true);
		});

		it("validates add_directive op", () => {
			const res = PreferenceOpSchema.safeParse({
				op: "add_directive",
				text: "Always respond in bullet points",
				confidence: 0.85,
			});
			expect(res.success).toBe(true);
		});

		it("validates add_preference_fact op", () => {
			const res = PreferenceOpSchema.safeParse({
				op: "add_preference_fact",
				claim: "Prefers TypeScript over Python",
				keywords: ["typescript", "preferences"],
				confidence: 0.95,
			});
			expect(res.success).toBe(true);
		});

		it("validates retract_trait op", () => {
			const res = PreferenceOpSchema.safeParse({
				op: "retract_trait",
				trait: "formality",
				reason: "user requested default style",
			});
			expect(res.success).toBe(true);
		});
	});

	describe("parsePreferenceOutputTolerant", () => {
		it("returns null when envelope is not { ops: [...] }", () => {
			expect(parsePreferenceOutputTolerant(null)).toBeNull();
			expect(parsePreferenceOutputTolerant("not an object")).toBeNull();
			expect(parsePreferenceOutputTolerant({ items: [] })).toBeNull();
		});

		it("tolerantly extracts valid ops and drops invalid traits or values", () => {
			const res = parsePreferenceOutputTolerant({
				ops: [
					{
						op: "set_trait",
						trait: "verbosity",
						value: "terse",
						confidence: 0.9,
					},
					{
						op: "set_trait",
						trait: "verbosity",
						value: "warm",
						confidence: 0.9,
					},
					{
						op: "unknown_op",
						trait: "verbosity",
					},
					{
						op: "add_directive",
						text: "Do not use emojis",
						confidence: 0.8,
					},
				],
			});

			expect(res).not.toBeNull();
			expect(res?.ops.length).toBe(2);
			expect(res?.ops[0].op).toBe("set_trait");
			expect(res?.ops[1].op).toBe("add_directive");
		});
	});
});
