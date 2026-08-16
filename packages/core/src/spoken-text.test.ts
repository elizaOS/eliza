/**
 * Unit coverage for the core spoken-text sanitizer: hidden model markup must
 * never reach server-side text-to-speech, including when a stream ends before
 * its closing tag arrives.
 */
import { describe, expect, it } from "vitest";

import { sanitizeSpeechText } from "./spoken-text";

const hiddenBlockTags = [
	"think",
	"analysis",
	"reasoning",
	"tool_call",
	"tool_calls",
	"tool",
	"tools",
] as const;

describe("sanitizeSpeechText", () => {
	it.each(hiddenBlockTags)(
		"removes a closed <%s> block and preserves following speech",
		(tag) => {
			expect(
				sanitizeSpeechText(
					`Visible. <${tag}>private payload</${tag}> Continue.`,
				),
			).toBe("Visible. Continue.");
		},
	);

	it.each(hiddenBlockTags)(
		"removes an unterminated <%s> block through end of input",
		(tag) => {
			expect(sanitizeSpeechText(`Visible. <${tag}>private payload`)).toBe(
				"Visible.",
			);
		},
	);

	it.each(hiddenBlockTags)(
		"removes a truncated <%s> opening tag through end of input",
		(tag) => {
			expect(sanitizeSpeechText(`Visible. <${tag} private payload`)).toBe(
				"Visible.",
			);
		},
	);

	// Twin-pin with packages/shared/src/spoken-text.test.ts (#20519): repeated
	// punctuation collapses BEFORE the spacing rules separate the repeats, so
	// identical model output speaks identically on both surfaces.
	it("removes non-speech directions and cleans repeated punctuation", () => {
		expect(
			sanitizeSpeechText("*whispers* Wait!!! (pause) Are you sure??"),
		).toBe("Wait! Are you sure?");
	});
});
