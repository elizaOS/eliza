/**
 * Deterministic unit coverage for the fact extractor's exported Zod schemas
 * and tolerant parser. The tests exercise the real schemas without a model,
 * runtime, database, or mocked parser behavior.
 */
import { describe, expect, it } from "vitest";
import {
	CurrentCategoryEnum,
	DurableCategoryEnum,
	ExtractorOutputSchema,
	OpSchema,
	parseExtractorOutputTolerant,
	VerificationStatusEnum,
} from "./factExtractor.schema.ts";

describe("factExtractor schemas", () => {
	it("exposes the complete closed category and verification sets", () => {
		expect(DurableCategoryEnum.options).toEqual([
			"identity",
			"health",
			"relationship",
			"life_event",
			"business_role",
			"preference",
			"goal",
		]);
		expect(CurrentCategoryEnum.options).toEqual([
			"feeling",
			"physical_state",
			"working_on",
			"going_through",
			"schedule_context",
		]);
		expect(VerificationStatusEnum.options).toEqual([
			"self_reported",
			"confirmed",
			"contradicted",
		]);

		expect(DurableCategoryEnum.safeParse("schedule_context").success).toBe(
			false,
		);
		expect(CurrentCategoryEnum.safeParse("identity").success).toBe(false);
		expect(VerificationStatusEnum.safeParse("unverified").success).toBe(false);
	});

	it("parses every operation variant and applies insert defaults", () => {
		const operations = [
			{ op: "add_durable", claim: "likes tea", category: "preference" },
			{ op: "add_current", claim: "feels rested", category: "feeling" },
			{ op: "strengthen", factId: "fact-1" },
			{ op: "decay", factId: "fact-2", reason: "no longer mentioned" },
			{
				op: "contradict",
				factId: "fact-3",
				proposedText: "now lives in Tokyo",
				reason: "the user corrected the claim",
			},
		] as const;

		const parsed = operations.map((operation) => OpSchema.parse(operation));

		expect(parsed.map((operation) => operation.op)).toEqual([
			"add_durable",
			"add_current",
			"strengthen",
			"decay",
			"contradict",
		]);
		expect(parsed[0]).toMatchObject({ structured_fields: {} });
		expect(parsed[1]).toMatchObject({ structured_fields: {} });
	});

	it("preserves structured fields, optional metadata, and every keyword", () => {
		const keywords = Array.from(
			{ length: 20 },
			(_, index) => `keyword-${index}`,
		);
		const parsed = OpSchema.parse({
			op: "add_durable",
			claim: "runs a bakery",
			category: "business_role",
			structured_fields: { role: "owner", locations: ["Pune", "Mumbai"] },
			keywords,
			verification_status: "confirmed",
			reason: "the business registry was cited",
		});

		expect(parsed).toEqual({
			op: "add_durable",
			claim: "runs a bakery",
			category: "business_role",
			structured_fields: { role: "owner", locations: ["Pune", "Mumbai"] },
			keywords,
			verification_status: "confirmed",
			reason: "the business registry was cited",
		});
	});

	it.each([
		[{ op: "add_durable", claim: "", category: "identity" }, "empty claim"],
		[
			{ op: "add_current", claim: "busy", category: "identity" },
			"wrong category set",
		],
		[{ op: "strengthen", factId: "" }, "empty fact id"],
		[{ op: "decay" }, "missing fact id"],
		[{ op: "contradict", factId: "fact-1", reason: "" }, "empty reason"],
		[
			{
				op: "add_durable",
				claim: "likes tea",
				category: "preference",
				keywords: ["tea", ""],
			},
			"empty keyword",
		],
		[{ op: "remove", factId: "fact-1" }, "unknown discriminator"],
	])("rejects %s (%s)", (operation) => {
		expect(OpSchema.safeParse(operation).success).toBe(false);
	});

	it("requires an ops array and validates it atomically", () => {
		expect(ExtractorOutputSchema.safeParse({ ops: [] }).success).toBe(true);
		expect(ExtractorOutputSchema.safeParse({}).success).toBe(false);
		expect(ExtractorOutputSchema.safeParse({ ops: "none" }).success).toBe(
			false,
		);
		expect(
			ExtractorOutputSchema.safeParse({
				ops: [{ op: "strengthen", factId: "fact-1" }, { op: "decay" }],
			}).success,
		).toBe(false);
	});
});

describe("parseExtractorOutputTolerant", () => {
	it("accepts object, JSON text, and fenced JSON envelopes", () => {
		const operation = { op: "strengthen", factId: "fact-1" };

		expect(parseExtractorOutputTolerant({ ops: [operation] })).toEqual({
			ops: [operation],
		});
		expect(
			parseExtractorOutputTolerant(JSON.stringify({ ops: [operation] })),
		).toEqual({ ops: [operation] });
		expect(
			parseExtractorOutputTolerant(
				`\n\`\`\`json\n${JSON.stringify({ ops: [operation] })}\n\`\`\`\n`,
			),
		).toEqual({ ops: [operation] });
	});

	it("normalizes legacy type discriminators without overriding an explicit op", () => {
		const parsed = parseExtractorOutputTolerant({
			ops: [
				{ type: "strengthen", factId: "legacy-fact" },
				{
					op: "decay",
					type: "strengthen",
					factId: "explicit-fact",
				},
			],
		});

		expect(parsed?.ops).toEqual([
			{ op: "strengthen", factId: "legacy-fact" },
			{ op: "decay", factId: "explicit-fact" },
		]);
	});

	it("keeps valid operations in their original order while dropping invalid entries", () => {
		const parsed = parseExtractorOutputTolerant({
			ops: [
				{ op: "strengthen", factId: "first" },
				null,
				["not", "an", "operation"],
				{ op: "contradict", factId: "missing-reason" },
				{ op: "decay", factId: "last" },
			],
		});

		expect(parsed?.ops).toEqual([
			{ op: "strengthen", factId: "first" },
			{ op: "decay", factId: "last" },
		]);
	});

	it.each([
		[null],
		[[]],
		[{}],
		[{ ops: null }],
		["not json"],
		['{"ops":'],
		["```json"],
		['```json\n{"ops":[]}'],
	])("returns null for a malformed envelope: %j", (output) => {
		expect(parseExtractorOutputTolerant(output)).toBeNull();
	});

	it("distinguishes an empty valid queue from a malformed envelope", () => {
		expect(parseExtractorOutputTolerant({ ops: [] })).toEqual({ ops: [] });
		expect(parseExtractorOutputTolerant('{"ops":[]}')).toEqual({ ops: [] });
	});
});
