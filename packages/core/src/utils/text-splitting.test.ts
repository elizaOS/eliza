/**
 * Tests for `extractFirstSentence`, the sentence-boundary splitter behind
 * reply/TTS early-emit: the cases pin abbreviation handling (e.g./i.e./Mr./Dr.,
 * including quoted/parenthesized/emphasized forms) so it never chops a reply
 * mid-abbreviation.
 */
import { describe, expect, it } from "vitest";
import { extractFirstSentence, hasFirstSentence } from "./text-splitting.ts";

describe("extractFirstSentence", () => {
	it("does not split inside dotted abbreviations (e.g. / i.e.)", () => {
		// Regression: `\w` excludes ".", so the preceding-word match extracted only
		// "g" from "e.g" and the "e.g"/"i.e" abbreviation entries were dead — the
		// first-sentence / TTS early-emit path chopped replies at "e."/"i.".
		const eg = extractFirstSentence("See e.g. the docs. Then continue.");
		expect(eg.first).toBe("See e.g. the docs.");
		expect(eg.rest).toBe("Then continue.");

		const ie = extractFirstSentence("Use the flag, i.e. the toggle. Done.");
		expect(ie.first).toBe("Use the flag, i.e. the toggle.");
		expect(ie.rest).toBe("Done.");
	});

	it("still honors the name-title abbreviations (Mr./Dr.)", () => {
		const r = extractFirstSentence("Mr. Smith arrived. He waved.");
		expect(r.first).toBe("Mr. Smith arrived.");
		expect(r.rest).toBe("He waved.");
	});

	it("does not split at abbreviations preceded by quotes/parens/asterisks", () => {
		// Regression from the [\w.]+ tightening: `(?:^|\s)` required start-of-string
		// or whitespace immediately before the token, so '"Dr' / '(Mr' / '*Dr'
		// never matched the abbreviation list and the first-sentence / TTS
		// early-emit path chopped mid-name ('He cited "Dr.'). The old \b regex
		// handled these.
		const quoted = extractFirstSentence(
			'He cited "Dr. Smith" as the source. Next sentence.',
		);
		expect(quoted.first).toBe('He cited "Dr. Smith" as the source.');
		expect(quoted.rest).toBe("Next sentence.");

		const paren = extractFirstSentence("(Mr. Jones agreed. Everyone left.)");
		expect(paren.first).toBe("(Mr. Jones agreed.");
		expect(paren.rest).toBe("Everyone left.)");

		const emphasized = extractFirstSentence("*Dr. Smith* arrived. He waved.");
		expect(emphasized.first).toBe("*Dr. Smith* arrived.");
		expect(emphasized.rest).toBe("He waved.");

		const quotedDotted = extractFirstSentence(
			'He said "etc." and moved on. Fine.',
		);
		expect(quotedDotted.first).toBe('He said "etc." and moved on.');
		expect(quotedDotted.rest).toBe("Fine.");
	});

	it("splits normal sentences at the first real boundary", () => {
		const r = extractFirstSentence("Hello world. Next one.");
		expect(r.first).toBe("Hello world.");
		expect(r.rest).toBe("Next one.");
	});

	it("includes trailing closing quotes and brackets in the first sentence", () => {
		const quoted = extractFirstSentence('She said, "Hello." Then she left.');
		expect(quoted.first).toBe('She said, "Hello."');
		expect(quoted.rest).toBe("Then she left.");
		expect(quoted.complete).toBe(true);

		const shouted = extractFirstSentence('He shouted, "Stop!" Everyone froze.');
		expect(shouted.first).toBe('He shouted, "Stop!"');
		expect(shouted.rest).toBe("Everyone froze.");
		expect(shouted.complete).toBe(true);

		const paren = extractFirstSentence(
			"(This is inside parentheses.) Outside text.",
		);
		expect(paren.first).toBe("(This is inside parentheses.)");
		expect(paren.rest).toBe("Outside text.");
		expect(paren.complete).toBe(true);

		const nested = extractFirstSentence("She replied, ‘Done.’)] Next step.");
		expect(nested.first).toBe("She replied, ‘Done.’)]");
		expect(nested.rest).toBe("Next step.");
		expect(nested.complete).toBe(true);
	});

	it("returns the whole text when there is no boundary", () => {
		const r = extractFirstSentence("No boundary here");
		expect(r.first).toBe("No boundary here");
		expect(r.rest).toBe("");
	});
});

describe("hasFirstSentence", () => {
	it("reports true when the whole text is one complete sentence", () => {
		// A boundary at end-of-string leaves `rest` empty, so keying off `rest`
		// reported false and the streaming voice path never fired.
		expect(hasFirstSentence("Sure, I added milk to your shopping list.")).toBe(
			true,
		);
		expect(hasFirstSentence("Did that work?")).toBe(true);
		expect(hasFirstSentence("Done!")).toBe(true);
	});

	it("still reports true when more text follows the first sentence", () => {
		expect(hasFirstSentence("One. Two.")).toBe(true);
	});

	it("reports false for an incomplete fragment", () => {
		expect(hasFirstSentence("Sure, I added")).toBe(false);
		expect(hasFirstSentence("")).toBe(false);
	});

	it("is not fooled by an abbreviation mid-fragment", () => {
		expect(hasFirstSentence("See e.g. the")).toBe(false);
	});
});

describe("extractFirstSentence quadratic abbreviation runs", () => {
	it("scans stacked title abbreviations in linear time", () => {
		const stacked = "Mr. ".repeat(40_000);
		const started = performance.now();
		const result = extractFirstSentence(stacked);
		const elapsed = performance.now() - started;
		expect(result.complete).toBe(false);
		expect(result.first.startsWith("Mr.")).toBe(true);
		// Origin spent ~16s on this input (substring+regex per period).
		expect(elapsed).toBeLessThan(200);
	});
});
