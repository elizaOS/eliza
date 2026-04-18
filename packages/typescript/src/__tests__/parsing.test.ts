import { describe, expect, it } from "vitest";
import { extractScheduleFollowUpResponseFromText } from "../features/shared/schedule-follow-up-response";
import {
	parseBooleanFromText,
	parseJSONObjectFromText,
	parseKeyValueXml,
} from "../utils";

describe("Parsing Module", () => {
	describe("parseBooleanFromText", () => {
		it("should parse exact YES/NO matches", () => {
			expect(parseBooleanFromText("YES")).toBe(true);
			expect(parseBooleanFromText("NO")).toBe(false);
		});

		it("should handle case insensitive input", () => {
			expect(parseBooleanFromText("yes")).toBe(true);
			expect(parseBooleanFromText("no")).toBe(false);
		});

		it("should return null for invalid input", () => {
			expect(parseBooleanFromText("")).toBe(false);
			expect(parseBooleanFromText("maybe")).toBe(false);
			expect(parseBooleanFromText("YES NO")).toBe(false);
		});
	});

	describe("parseJSONObjectFromText", () => {
		it("should parse JSON object from code block", () => {
			const input = '```json\n{"key": "value", "number": 42}\n```';
			expect(parseJSONObjectFromText(input)).toEqual({
				key: "value",
				number: 42,
			});
		});

		it("should parse JSON object without code block", () => {
			const input = '{"key": "value", "number": 42}';
			expect(parseJSONObjectFromText(input)).toEqual({
				key: "value",
				number: 42,
			});
		});

		it("should parse JSON objects containing array values", () => {
			const input = '{"key": ["item1", "item2", "item3"]}';
			expect(parseJSONObjectFromText(input)).toEqual({
				key: ["item1", "item2", "item3"],
			});
		});

		it("should handle empty objects", () => {
			expect(parseJSONObjectFromText("```json\n{}\n```")).toEqual({});
			expect(parseJSONObjectFromText("```\n{}\n```")).toEqual({});
			expect(parseJSONObjectFromText("{}")).toEqual({});
		});

		it("should return null for invalid JSON", () => {
			expect(parseJSONObjectFromText("invalid")).toBeNull();
			expect(parseJSONObjectFromText("{invalid}")).toBeNull();
			expect(parseJSONObjectFromText("```json\n{invalid}\n```")).toBeNull();
		});
	});

	describe("parseKeyValueXml", () => {
		it("parses TOON fields that appear after explanatory preamble text", () => {
			const input = `
Here's the extracted information in TOON format:

TOON
contactName: David
entityId:
scheduledAt: 2026-04-25T00:00:00.000Z
reason: Follow up about the project
priority: high
message:
`.trim();

			expect(parseKeyValueXml(input)).toEqual({
				contactName: "David",
				entityId: "",
				scheduledAt: "2026-04-25T00:00:00.000Z",
				reason: "Follow up about the project",
				priority: "high",
				message: "",
			});
		});

		it("parses loose TOON fields even when the model adds prose before them", () => {
			const input = `
I found the fields below.

contactName: Sarah Chen
entityId:
scheduledAt: 2026-02-01T09:00:00Z
reason: Check in on the agent framework demo
priority: medium
message: Send the latest deck before the call
`.trim();

			expect(parseKeyValueXml(input)).toEqual({
				contactName: "Sarah Chen",
				entityId: "",
				scheduledAt: "2026-02-01T09:00:00Z",
				reason: "Check in on the agent framework demo",
				priority: "medium",
				message: "Send the latest deck before the call",
			});
		});
	});

	describe("extractScheduleFollowUpResponseFromText", () => {
		it("parses labeled markdown bullets from schedule follow-up model output", () => {
			const input = `
- \`contactName\`: \`David\`
- \`entityId\`: Not available
- \`scheduledAt\`: \`2026-04-25T14:00:00.000Z\` (assuming next week is the week after April 18)
- \`reason\`: "about the project"
- \`priority\`: \`medium\`
`.trim();

			expect(extractScheduleFollowUpResponseFromText(input)).toEqual({
				contactName: "David",
				entityId: "",
				scheduledAt: "2026-04-25T14:00:00.000Z",
				reason: "about the project",
				priority: "medium",
			});
		});
	});
});
