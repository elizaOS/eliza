/**
 * Unit tests for factExtractor.schema: validates fact categories,
 * discriminated op schemas, markdown fence stripping, and tolerant parsing.
 */
import { describe, expect, it } from "vitest";
import {
	CurrentCategoryEnum,
	DurableCategoryEnum,
	OpSchema,
	parseExtractorOutputTolerant,
	VerificationStatusEnum,
} from "./factExtractor.schema.ts";

describe("factExtractor.schema", () => {
	describe("Category Enums", () => {
		it("validates durable categories", () => {
			expect(DurableCategoryEnum.safeParse("identity").success).toBe(true);
			expect(DurableCategoryEnum.safeParse("health").success).toBe(true);
			expect(DurableCategoryEnum.safeParse("relationship").success).toBe(true);
			expect(DurableCategoryEnum.safeParse("invalid_cat").success).toBe(false);
		});

		it("validates current categories", () => {
			expect(CurrentCategoryEnum.safeParse("working_on").success).toBe(true);
			expect(CurrentCategoryEnum.safeParse("feeling").success).toBe(true);
			expect(CurrentCategoryEnum.safeParse("invalid_cat").success).toBe(false);
		});

		it("validates verification statuses", () => {
			expect(VerificationStatusEnum.safeParse("self_reported").success).toBe(
				true,
			);
			expect(VerificationStatusEnum.safeParse("confirmed").success).toBe(true);
			expect(VerificationStatusEnum.safeParse("contradicted").success).toBe(
				true,
			);
		});
	});

	describe("OpSchema", () => {
		it("validates add_durable op", () => {
			const res = OpSchema.safeParse({
				op: "add_durable",
				claim: "Lives in Seattle",
				category: "identity",
				keywords: ["seattle", "location"],
			});
			expect(res.success).toBe(true);
			if (res.success && res.data.op === "add_durable") {
				expect(res.data.structured_fields).toEqual({});
			}
		});

		it("validates add_current op", () => {
			const res = OpSchema.safeParse({
				op: "add_current",
				claim: "Working on compiler migration",
				category: "working_on",
				valid_at: "2026-08-24T00:00:00Z",
			});
			expect(res.success).toBe(true);
		});

		it("validates strengthen, decay, and contradict ops", () => {
			expect(
				OpSchema.safeParse({ op: "strengthen", factId: "fact-1" }).success,
			).toBe(true);
			expect(
				OpSchema.safeParse({ op: "decay", factId: "fact-1" }).success,
			).toBe(true);
			expect(
				OpSchema.safeParse({
					op: "contradict",
					factId: "fact-1",
					reason: "Moved to Tokyo",
				}).success,
			).toBe(true);
		});
	});

	describe("parseExtractorOutputTolerant", () => {
		it("normalizes legacy type field to op", () => {
			const raw = {
				ops: [
					{
						type: "strengthen",
						factId: "fact-123",
					},
				],
			};
			const res = parseExtractorOutputTolerant(raw);
			expect(res?.ops.length).toBe(1);
			expect(res?.ops[0].op).toBe("strengthen");
		});

		it("drops malformed ops and keeps valid ones", () => {
			const raw = {
				ops: [
					{ op: "strengthen" },
					{ op: "add_durable", claim: "Has a dog", category: "relationship" },
				],
			};
			const res = parseExtractorOutputTolerant(raw);
			expect(res?.ops.length).toBe(1);
			expect(res?.ops[0].op).toBe("add_durable");
		});
	});
});
