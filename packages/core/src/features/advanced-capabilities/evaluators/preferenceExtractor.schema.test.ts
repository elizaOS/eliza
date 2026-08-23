/**
 * Unit tests for preference extractor schemas and tolerant output parser.
 */

import { describe, expect, it } from "vitest";
import {
	PreferenceOpSchema,
	PreferenceTraitEnum,
	parsePreferenceOutputTolerant,
} from "./preferenceExtractor.schema.js";

describe("preferenceExtractor.schema", () => {
	it("validates PreferenceTraitEnum values", () => {
		expect(PreferenceTraitEnum.safeParse("verbosity").success).toBe(true);
		expect(PreferenceTraitEnum.safeParse("tone").success).toBe(true);
		expect(PreferenceTraitEnum.safeParse("formality").success).toBe(true);
		expect(PreferenceTraitEnum.safeParse("reply_gate").success).toBe(false);
	});

	it("validates PreferenceOpSchema discriminated union members", () => {
		const setTraitOp = {
			op: "set_trait",
			trait: "verbosity",
			value: "terse",
			confidence: 0.9,
		};
		expect(PreferenceOpSchema.safeParse(setTraitOp).success).toBe(true);

		const directiveOp = {
			op: "add_directive",
			text: "Always provide TypeScript code snippets",
			confidence: 0.85,
		};
		expect(PreferenceOpSchema.safeParse(directiveOp).success).toBe(true);

		const factOp = {
			op: "add_preference_fact",
			claim: "User loves dark mode",
			keywords: ["dark", "mode"],
			confidence: 0.95,
		};
		expect(PreferenceOpSchema.safeParse(factOp).success).toBe(true);

		const retractOp = {
			op: "retract_trait",
			trait: "tone",
			reason: "User requested neutral tone",
		};
		expect(PreferenceOpSchema.safeParse(retractOp).success).toBe(true);
	});

	it("parses extractor output tolerantly dropping invalid operations while preserving valid ones", () => {
		const mixedPayload = {
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
					value: "invalid_verbosity_value_xyz", // dropped: not in VERBOSITY_VALUES
					confidence: 0.9,
				},
				{
					op: "add_directive",
					text: "Prefer functional programming",
					confidence: 0.8,
				},
				{
					op: "unknown_operation_xyz",
				},
			],
		};

		const result = parsePreferenceOutputTolerant(mixedPayload);
		expect(result).not.toBeNull();
		expect(result?.ops).toHaveLength(2);
		expect(result?.ops[0].op).toBe("set_trait");
		expect(result?.ops[1].op).toBe("add_directive");

		// Invalid non-envelope returns null
		expect(parsePreferenceOutputTolerant(null)).toBeNull();
		expect(parsePreferenceOutputTolerant({ not_ops: [] })).toBeNull();
	});
});
