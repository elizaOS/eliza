/**
 * Tests for `extractFirstSentence`, the sentence-boundary splitter behind
 * reply/TTS early-emit: the cases pin abbreviation handling (e.g./i.e./Mr./Dr.,
 * including quoted/parenthesized/emphasized forms) so it never chops a reply
 * mid-abbreviation.
 */
import { describe, expect, it } from "vitest";
import {
	createFirstSentenceScanner,
	createFirstSentenceStreamTracker,
	extractFirstSentence,
	hasFirstSentence,
} from "./text-splitting.ts";

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

	it("preserves Unicode text while recognizing Unicode whitespace", () => {
		const spaced = extractFirstSentence("Café.\u00a0Après.");
		expect(spaced).toEqual({
			first: "Café.",
			rest: "Après.",
			complete: true,
		});
		expect(extractFirstSentence("你好。下一句。").complete).toBe(false);
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
	it("scans stacked title abbreviations without finding a false boundary", () => {
		const stacked = "Mr. ".repeat(40_000);
		const result = extractFirstSentence(stacked);
		expect(result.complete).toBe(false);
		expect(result.first.startsWith("Mr.")).toBe(true);
	});
});

describe("createFirstSentenceScanner", () => {
	it("scans abbreviation-heavy streaming deltas only once", () => {
		const scanner = createFirstSentenceScanner();
		let boundary: number | undefined;
		for (let index = 0; index < 40_000; index += 1) {
			boundary = scanner.push("Mr. ");
		}
		expect(boundary).toBeUndefined();
		expect(scanner.push("Done.")).toBeUndefined();
		expect(scanner.push("", true)).toBe(160_005);
	});

	it("does not early-emit a dotted abbreviation split across chunks", () => {
		const scanner = createFirstSentenceScanner();
		expect(scanner.push("See e.")).toBeUndefined();
		expect(scanner.push("g. the docs.")).toBeUndefined();
		expect(scanner.push("", true)).toBe(18);
	});

	it("resolves an ambiguous dotted prefix when the next chunk is not an abbreviation", () => {
		const scanner = createFirstSentenceScanner();
		expect(scanner.push("e.")).toBeUndefined();
		expect(scanner.push(" Next sentence.")).toBe(2);

		const quoted = createFirstSentenceScanner();
		expect(quoted.push("e.")).toBeUndefined();
		expect(quoted.push('" Next sentence.')).toBe(3);
	});

	it("preserves title state across arbitrary chunk boundaries", () => {
		const scanner = createFirstSentenceScanner();
		const chunks = ["D", "r.", " Smith arrived", ". Next."];
		let accumulated = "";
		let boundary: number | undefined;
		for (const chunk of chunks) {
			accumulated += chunk;
			boundary = scanner.push(chunk);
			if (boundary !== undefined) break;
		}
		expect(accumulated.slice(0, boundary)).toBe("Dr. Smith arrived.");
	});

	it.each([
		["Hello.", '" Next.', 'Hello."'],
		["Stop!", ") Next.", "Stop!)"],
		["What?", "” Next.", "What?”"],
	])(
		"includes a closer delivered after terminal %s",
		(first, second, expected) => {
			const scanner = createFirstSentenceScanner();
			expect(scanner.push(first)).toBeUndefined();
			const boundary = scanner.push(second);
			expect(`${first}${second}`.slice(0, boundary)).toBe(expected);
		},
	);

	it("defers terminal punctuation that becomes a decimal continuation", () => {
		const scanner = createFirstSentenceScanner();
		expect(scanner.push("Version 1.")).toBeUndefined();
		const second = "2 is stable.";
		const boundary = scanner.push(second);
		expect(`Version 1.${second}`.slice(0, boundary)).toBe(
			"Version 1.2 is stable.",
		);
	});

	it("consumes closers split across multiple chunks and resolves punctuation at EOF", () => {
		const scanner = createFirstSentenceScanner();
		expect(scanner.push("Hello.")).toBeUndefined();
		expect(scanner.push('"')).toBeUndefined();
		expect(scanner.push(") Next.")).toBe(8);

		const atEof = createFirstSentenceScanner();
		expect(atEof.push("Finished.")).toBeUndefined();
		expect(atEof.push("", true)).toBe(9);
	});

	it("matches direct semantics at every split and one-code-unit chunking", () => {
		const cases = [
			"Hello. Next.",
			'Hello.") Next.',
			"Version 1.2 is stable. Next.",
			"See e.g. the docs. Next.",
			"Dr. Smith arrived! Next.",
			"Café.\u00a0Après.",
			"你好。下一句。",
		];

		for (const text of cases) {
			const expected = createFirstSentenceScanner().push(text, true);
			for (let split = 0; split <= text.length; split += 1) {
				const scanner = createFirstSentenceScanner();
				const beforeSplit = scanner.push(text.slice(0, split));
				expect(beforeSplit ?? scanner.push(text.slice(split), true)).toBe(
					expected,
				);
			}

			const scanner = createFirstSentenceScanner();
			let actual: number | undefined;
			for (let offset = 0; offset < text.length; offset += 1) {
				actual = scanner.push(text[offset]);
				if (actual !== undefined) break;
			}
			expect(actual ?? scanner.push("", true)).toBe(expected);
		}
	});
});

describe("createFirstSentenceStreamTracker", () => {
	it("ignores a late callback from an older structured-stream revision", () => {
		const tracker = createFirstSentenceStreamTracker();
		expect(tracker.push("Mr.", "Mr.", 1)).toBeUndefined();
		expect(tracker.push("Done.", "Done.", 2)).toBeUndefined();
		expect(tracker.push(" stale.", "Mr. stale.", 1)).toBeUndefined();
		expect(tracker.finish()).toBe(5);
	});

	it("reconciles equal-length prefix rewrites instead of trusting the delta", () => {
		const tracker = createFirstSentenceStreamTracker();
		expect(tracker.push("Mr", "Mr")).toBeUndefined();
		// The suffix and total length still look append-only, but the authoritative
		// producer replaced the prefix while retrying. Replaying "Go." finds the
		// boundary that stale "Mr." abbreviation state would suppress.
		expect(tracker.push(".", "Go.", 1)).toBeUndefined();
		expect(tracker.finish()).toBe(3);
	});

	it("resets and replays authoritative accumulation after a structured retry", () => {
		const tracker = createFirstSentenceStreamTracker();
		expect(tracker.push("Mr", "Mr")).toBeUndefined();
		expect(
			tracker.push("Dr. Jones arrived.", "Dr. Jones arrived."),
		).toBeUndefined();
		expect(tracker.finish()).toBe(18);
	});

	it("keeps abbreviation-heavy authoritative streaming append-only", () => {
		const tracker = createFirstSentenceStreamTracker();
		let accumulated = "";
		for (let index = 0; index < 40_000; index += 1) {
			const chunk = "Mr. ";
			accumulated += chunk;
			expect(tracker.push(chunk, accumulated)).toBeUndefined();
		}
		accumulated += "Done.";
		expect(tracker.push("Done.", accumulated)).toBeUndefined();
		expect(tracker.finish()).toBe(160_005);
	});
});
