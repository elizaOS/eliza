/**
 * Unit coverage for the core spoken-text sanitizer: hidden model markup must
 * never reach server-side text-to-speech, including when a stream ends before
 * its closing tag arrives.
 */
import { describe, expect, it } from "vitest";

import { sanitizeSpeechText } from "./spoken-text";

describe("sanitizeSpeechText", () => {
	it("removes an unterminated hidden model block through end of input", () => {
		expect(
			sanitizeSpeechText(
				"Visible answer. <analysis>private reasoning must not be spoken",
			),
		).toBe("Visible answer.");
	});
});
