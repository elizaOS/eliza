/**
 * Unit tests for fact extractor Zod schemas and tolerant output parsing.
 */

import { describe, expect, it } from "vitest";
import {
	CurrentCategoryEnum,
	DurableCategoryEnum,
	OpSchema,
	parseExtractorOutputTolerant,
	VerificationStatusEnum,
} from "./factExtractor.schema.js";

describe("factExtractor.schema", () => {
	it("validates categories and verification statuses", () => {
		expect(DurableCategoryEnum.safeParse("identity").success).toBe(true);
		expect(DurableCategoryEnum.safeParse("preference").success).toBe(true);
		expect(DurableCategoryEnum.safeParse("invalid_category").success).toBe(
			false,
		);

		expect(CurrentCategoryEnum.safeParse("feeling").success).toBe(true);
		expect(CurrentCategoryEnum.safeParse("working_on").success).toBe(true);

		expect(VerificationStatusEnum.safeParse("self_reported").success).toBe(
			true,
		);
		expect(VerificationStatusEnum.safeParse("confirmed").success).toBe(true);
	});

	it("validates all OpSchema variants", () => {
		const addDurable = {
			op: "add_durable",
			claim: "Lives in San Francisco",
			category: "identity",
			keywords: ["san francisco", "home"],
		};
		expect(OpSchema.safeParse(addDurable).success).toBe(true);

		const addCurrent = {
			op: "add_current",
			claim: "Writing a research paper",
			category: "working_on",
			valid_at: new Date().toISOString(),
		};
		expect(OpSchema.safeParse(addCurrent).success).toBe(true);

		const strengthen = {
			op: "strengthen",
			factId: "fact-123",
			reason: "User re-confirmed",
		};
		expect(OpSchema.safeParse(strengthen).success).toBe(true);

		const decay = {
			op: "decay",
			factId: "fact-456",
		};
		expect(OpSchema.safeParse(decay).success).toBe(true);

		const contradict = {
			op: "contradict",
			factId: "fact-789",
			proposedText: "Actually moved to New York",
			reason: "User stated new city",
		};
		expect(OpSchema.safeParse(contradict).success).toBe(true);
	});

	it("tolerantly parses extractor output and handles markdown fenced JSON string input", () => {
		const markdownOutput = `\`\`\`json
{
  "ops": [
    {
      "op": "add_durable",
      "claim": "Speaks Japanese",
      "category": "identity"
    },
    {
      "op": "contradict",
      "factId": "fact-1"
    },
    {
      "op": "decay",
      "factId": "fact-2"
    }
  ]
}
\`\`\``;

		const result = parseExtractorOutputTolerant(markdownOutput);
		expect(result).not.toBeNull();
		// contradict missing reason is dropped, so 2 ops remain
		expect(result?.ops).toHaveLength(2);
		expect(result?.ops[0].op).toBe("add_durable");
		expect(result?.ops[1].op).toBe("decay");
	});
});
