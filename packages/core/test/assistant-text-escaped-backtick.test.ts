import { describe, expect, it } from "vitest";
import { stripAssistantStageDirections } from "../src/utils/assistant-text";

describe("stripAssistantStageDirections with escaped backticks", () => {
	it("keeps a stage direction that sits inside a code span with an escaped backtick", () => {
		// The middle backtick is backslash-escaped, so it is literal text, not
		// a code-span delimiter: the span runs from the first backtick to the
		// last one, and `*beams*` is code content that must survive.
		const input = "A `x \\` *beams* y` B";
		expect(stripAssistantStageDirections(input)).toBe(input);
	});

	it("keeps a stage direction at the end of such a code span", () => {
		const input = "Say `hi \\` *waves* ok` now";
		expect(stripAssistantStageDirections(input)).toBe(input);
	});

	it("still strips a stage direction in plain prose", () => {
		expect(stripAssistantStageDirections("Hello *smiles* there")).toBe(
			"Hello there",
		);
	});

	it("still strips a direction after a code span closed by a real delimiter", () => {
		// Two backslashes before the backtick: the backtick IS a delimiter,
		// so the span ends there and the direction after it is prose.
		expect(
			stripAssistantStageDirections("Keep `code \\\\` *smiles* done"),
		).toBe("Keep `code \\\\` done");
	});

	it("still preserves a direction inside an ordinary code span", () => {
		const input = "Keep `*smiles*` safe";
		expect(stripAssistantStageDirections(input)).toBe(input);
	});
});
