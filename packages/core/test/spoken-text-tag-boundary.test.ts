/**
 * `sanitizeSpeechText` drops reasoning and tool blocks by tag name. A longer
 * hyphenated name such as `<thought-bubble>` is not one of those tags.
 */

import { describe, expect, it } from "vitest";
import { sanitizeSpeechText } from "../src/spoken-text";

describe("sanitizeSpeechText hidden tag names", () => {
	it("speaks the text after a hyphenated tag that only starts like a hidden tag", () => {
		expect(
			sanitizeSpeechText(
				"Use the <thought-bubble> component. It renders a balloon.",
			),
		).toBe("Use the component. It renders a balloon.");
		expect(sanitizeSpeechText("Add a <tool-tip> to the button.")).toBe(
			"Add a to the button.",
		);
	});

	it("still drops reasoning and tool blocks", () => {
		expect(sanitizeSpeechText("a <think>secret</think> b")).toBe("a b");
		expect(sanitizeSpeechText("a <tool_call>{}</tool_call> b")).toBe("a b");
		expect(sanitizeSpeechText("a <thinking>open")).toBe("a");
	});
});
