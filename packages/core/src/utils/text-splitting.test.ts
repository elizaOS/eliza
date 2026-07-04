/**
 * Tests for `extractFirstSentence`, the sentence-boundary splitter behind
 * reply/TTS early-emit: the cases pin abbreviation handling (e.g./i.e./Mr./Dr.,
 * including quoted/parenthesized/emphasized forms) so it never chops a reply
 * mid-abbreviation.
 */
import { describe, expect, it } from "vitest";
import { extractFirstSentence } from "./text-splitting.ts";

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

	it("returns the whole text when there is no boundary", () => {
		const r = extractFirstSentence("No boundary here");
		expect(r.first).toBe("No boundary here");
		expect(r.rest).toBe("");
	});
});
