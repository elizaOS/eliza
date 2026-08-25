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

	it("keeps speech around a few nested stage-direction layers", () => {
		expect(
			sanitizeSpeechText("Hello (aside (whisper) still aside) world."),
		).toBe("Hello world.");
	});

	it("fail-closes a nested-delimiter peel bomb without hanging TTS", () => {
		const nested = `(${"(".repeat(40_000)}hello${")".repeat(40_000)})`;
		const spoken = sanitizeSpeechText(`Say this. ${nested} Done.`);
		expect(spoken).toBe("Say this. Done.");
	});

	it("does not expose text from outer layers after the peel budget", () => {
		let nested = "(pause)";
		for (let depth = 0; depth < 12; depth += 1) {
			nested = `(secret-${depth} ${nested})`;
		}
		expect(sanitizeSpeechText(`Say this. ${nested} Done.`)).toBe(
			"Say this. Done.",
		);
	});

	it.each(["*", "**"])(
		"does not expose deeply nested %s directions after the peel budget",
		(marker) => {
			let nested = `${marker}pause${marker}`;
			for (let depth = 0; depth < 12; depth += 1) {
				nested = `${marker}secret-${depth} ${nested} tail-${depth}${marker}`;
			}
			expect(sanitizeSpeechText(`Say this. ${nested} Done.`)).toBe(
				"Say this. Done.",
			);
		},
	);

	it("keeps legacy unmatched-direction text while dropping its delimiter", () => {
		expect(sanitizeSpeechText("Say this (perhaps later")).toBe(
			"Say this perhaps later",
		);
	});
});

describe("sanitizeSpeechText additional coverage", () => {
	it("strips markdown links to text", () => {
		expect(sanitizeSpeechText("Check [Eliza](https://elizaos.ai) docs")).toBe(
			"Check Eliza docs",
		);
	});

	it("strips code fences and inline code to inner text", () => {
		expect(sanitizeSpeechText("Use ```js\nconsole.log(1)\n``` now")).toBe(
			"Use now",
		);
		expect(sanitizeSpeechText("Run `npm test` please")).toBe(
			"Run npm test please",
		);
	});

	it("strips raw HTML tags", () => {
		expect(sanitizeSpeechText("Hello <b>bold</b> world")).toBe(
			"Hello bold world",
		);
		expect(sanitizeSpeechText('Text <span class="x">span</span> end')).toBe(
			"Text span end",
		);
	});

	it("strips URLs", () => {
		expect(sanitizeSpeechText("Visit https://example.com/path?q=1 now")).toBe(
			"Visit now",
		);
		expect(sanitizeSpeechText("See http://test.com and https://a.com/b")).toBe(
			"See and",
		);
	});

	it("normalizes punctuation and whitespace", () => {
		expect(sanitizeSpeechText("Hello,,  world!!")).toBe("Hello, world!");
		expect(sanitizeSpeechText("Wait   \n\n  what???")).toBe("Wait what?");
	});
});
