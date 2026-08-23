/**
 * Deterministic unit coverage for the passive preference extractor's schemas
 * and tolerant parser, including every operation variant and malformed-item
 * isolation. The suite drives the real Zod transforms and trait/value policy.
 */
import { describe, expect, it, vi } from "vitest";
import { logger } from "../../../logger.ts";
import {
	PreferenceOpSchema,
	PreferenceTraitEnum,
	parsePreferenceOutputTolerant,
} from "./preferenceExtractor.schema.ts";

describe("PreferenceTraitEnum", () => {
	it("accepts exactly the traits available to passive inference", () => {
		expect(PreferenceTraitEnum.options).toEqual([
			"verbosity",
			"tone",
			"formality",
		]);
		expect(PreferenceTraitEnum.safeParse("reply_gate").success).toBe(false);
	});
});

describe("PreferenceOpSchema", () => {
	it("parses every operation variant and preserves optional evidence", () => {
		const operations = [
			{
				op: "set_trait",
				trait: "verbosity",
				value: "terse",
				confidence: 1,
				evidence: "shorter answers, please",
			},
			{
				op: "add_directive",
				text: "  Prefer numbered steps  ",
				confidence: 0,
				evidence: "number those",
			},
			{
				op: "add_preference_fact",
				claim: "prefers dark themes",
				keywords: ["dark", "theme", "dark"],
				confidence: 0.75,
				evidence: "dark mode is easier on my eyes",
			},
			{
				op: "retract_trait",
				trait: "tone",
				reason: "the user changed their mind",
			},
		] as const;

		const parsed = operations.map((operation) =>
			PreferenceOpSchema.parse(operation),
		);

		expect(parsed.map((operation) => operation.op)).toEqual([
			"set_trait",
			"add_directive",
			"add_preference_fact",
			"retract_trait",
		]);
		expect(parsed[0]).toMatchObject({
			evidence: "shorter answers, please",
		});
		expect(parsed[1]).toMatchObject({ text: "Prefer numbered steps" });
		expect(parsed[2]).toMatchObject({
			keywords: ["dark", "theme", "dark"],
		});
		expect(parsed[3]).toMatchObject({
			reason: "the user changed their mind",
		});
	});

	it.each([
		{ op: "set_trait", trait: "tone", value: "warm", confidence: -0.01 },
		{ op: "set_trait", trait: "tone", value: "warm", confidence: 1.01 },
		{ op: "add_directive", text: "be direct", confidence: -0.01 },
		{ op: "add_directive", text: "be direct", confidence: 1.01 },
	])("rejects out-of-range confidence in $op", (operation) => {
		expect(PreferenceOpSchema.safeParse(operation).success).toBe(false);
	});

	it.each([
		{ op: "set_trait", trait: "tone", value: "", confidence: 0.9 },
		{ op: "add_directive", text: "   ", confidence: 0.9 },
		{ op: "add_preference_fact", claim: "" },
		{ op: "add_preference_fact", claim: "likes tea", keywords: [""] },
		{ op: "retract_trait", trait: "reply_gate" },
		{ op: "unknown" },
	])("rejects malformed $op operations", (operation) => {
		expect(PreferenceOpSchema.safeParse(operation).success).toBe(false);
	});
});

describe("parsePreferenceOutputTolerant", () => {
	it.each([null, undefined, [], {}, { ops: null }, { ops: {} }])(
		"returns null for an invalid envelope: %j",
		(output) => {
			expect(parsePreferenceOutputTolerant(output)).toBeNull();
		},
	);

	it("accepts an empty operation list", () => {
		expect(parsePreferenceOutputTolerant({ ops: [] })).toEqual({ ops: [] });
	});

	it("preserves the order and complete fields of valid operations", () => {
		const output = {
			ops: [
				{
					op: "add_preference_fact",
					claim: "prefers compact tables",
					keywords: ["tables", "compact", "tables"],
				},
				{
					op: "set_trait",
					trait: "formality",
					value: "professional",
					confidence: 0.8,
				},
				{ op: "retract_trait", trait: "verbosity" },
			],
		};

		expect(parsePreferenceOutputTolerant(output)).toEqual(output);
	});

	it.each([
		["verbosity", "terse"],
		["verbosity", "normal"],
		["verbosity", "verbose"],
		["tone", "warm"],
		["tone", "neutral"],
		["tone", "direct"],
		["tone", "cold"],
		["formality", "casual"],
		["formality", "professional"],
		["formality", "formal"],
	] as const)("accepts the %s/%s trait-value pairing", (trait, value) => {
		const parsed = parsePreferenceOutputTolerant({
			ops: [{ op: "set_trait", trait, value, confidence: 0.8 }],
		});

		expect(parsed?.ops).toEqual([
			{ op: "set_trait", trait, value, confidence: 0.8 },
		]);
	});

	it("drops schema failures and trait-value mismatches while keeping valid siblings", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const parsed = parsePreferenceOutputTolerant({
				ops: [
					{ op: "add_preference_fact", claim: "prefers keyboard shortcuts" },
					{ op: "add_directive", text: "   ", confidence: 0.9 },
					{
						op: "set_trait",
						trait: "verbosity",
						value: "warm",
						confidence: 0.9,
					},
					{ op: "retract_trait", trait: "formality" },
				],
			});

			expect(parsed?.ops).toEqual([
				{ op: "add_preference_fact", claim: "prefers keyboard shortcuts" },
				{ op: "retract_trait", trait: "formality" },
			]);
			expect(warn).toHaveBeenCalledOnce();
			expect(warn).toHaveBeenCalledWith(
				expect.objectContaining({
					src: "preferences",
					count: 2,
					issues: [
						expect.stringContaining("text"),
						expect.stringContaining("not a valid verbosity value"),
					],
				}),
				"dropped malformed preference op(s)",
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("does not warn when every operation is valid", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			expect(
				parsePreferenceOutputTolerant({
					ops: [{ op: "retract_trait", trait: "tone" }],
				}),
			).toEqual({ ops: [{ op: "retract_trait", trait: "tone" }] });
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});
