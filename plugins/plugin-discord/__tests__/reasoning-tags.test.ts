/**
 * Unit tests for stripReasoningTags — the pre-send sanitizer that removes
 * model reasoning tags, end-of-turn sentinels, and native tool-call syntax
 * from generated text while preserving fenced code blocks.
 */
import { describe, expect, it } from "vitest";
import { stripReasoningTags } from "../reasoning-tags";

describe("stripReasoningTags", () => {
	it("strips paired reasoning tags with their contents", () => {
		expect(
			stripReasoningTags("<thinking>internal notes</thinking>The answer is 4."),
		).toBe("The answer is 4.");
	});

	it("strips an unclosed reasoning tag to end of text", () => {
		expect(stripReasoningTags("The answer is 4.<reasoning>and then I")).toBe(
			"The answer is 4.",
		);
	});

	it("strips an unclosed native tool_call leak (observed live)", () => {
		// glm-4.7 drifted out of the response grammar mid-turn and this exact
		// shape reached Discord verbatim.
		expect(
			stripReasoningTags(
				"Let me try the weather action for current conditions.<tool_call>get_weather",
			),
		).toBe("Let me try the weather action for current conditions.");
	});

	it("strips paired tool_call and function_call blocks with contents", () => {
		expect(
			stripReasoningTags(
				'Done.<tool_call>{"name":"get_weather","args":{}}</tool_call>',
			),
		).toBe("Done.");
		expect(
			stripReasoningTags("Sure.<function_call>lookup(x)</function_call> Next."),
		).toBe("Sure. Next.");
	});

	it("preserves tool_call syntax inside fenced code blocks", () => {
		const text =
			"Example:\n```xml\n<tool_call>get_weather</tool_call>\n```\nThat is the format.";
		expect(stripReasoningTags(text)).toBe(text);
	});

	it("leaves plain text untouched", () => {
		expect(stripReasoningTags("Bitcoin is at $63,217.")).toBe(
			"Bitcoin is at $63,217.",
		);
	});
});
