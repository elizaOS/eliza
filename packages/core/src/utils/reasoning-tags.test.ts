/**
 * Covers the private-reasoning tag utilities. `hasReasoningResidue` is the deny
 * gate both user-visible egress legs in the planner loop route through, so its
 * documented properties are load-bearing: it denies on the tag PREFIX alone
 * (an unterminated `<reasoning` is still residue), it is case-insensitive, and
 * it must be stateless across repeated calls — the module comment explicitly
 * forbids the `g` flag there because `RegExp.prototype.test` on a global regex
 * retains `lastIndex` and alternates true/false on identical input.
 *
 * The stripping helpers carry the complementary contract: pairs collapse
 * non-greedily against the NEAREST later close, an unmatched open is preserved
 * so downstream gates still fail closed, and a candidate with no reachable `>`
 * forms no tag at all. Pure functions — no runtime, no model, no IO.
 */
import { describe, expect, it } from "vitest";

import {
	findNextCloseTag,
	findNextOpenTag,
	hasReasoningResidue,
	REASONING_TAG_NAMES,
	stripPairedTagBlocks,
	stripReasoningPrefixes,
	stripUnclosedTagSuffix,
} from "./reasoning-tags.ts";

const ALT = REASONING_TAG_NAMES.join("|");

describe("hasReasoningResidue", () => {
	it("denies every canonical tag name, open and close", () => {
		for (const name of REASONING_TAG_NAMES) {
			expect(hasReasoningResidue(`before <${name}>x</${name}> after`)).toBe(
				true,
			);
			expect(hasReasoningResidue(`trailing </${name}>`)).toBe(true);
		}
	});

	it("denies on the tag prefix alone, with no terminator present", () => {
		// The gate deliberately does not require `>`; an unterminated tag is
		// residue too, and requiring a terminator here was the fail-open half of
		// the DoS defect the module documents.
		expect(hasReasoningResidue("oops <reasoning")).toBe(false);
		expect(hasReasoningResidue("oops <reasoning ")).toBe(true);
		expect(hasReasoningResidue("oops </think ")).toBe(true);
		expect(hasReasoningResidue("oops <think/")).toBe(true);
	});

	it("is case-insensitive and tolerates whitespace inside the tag head", () => {
		expect(hasReasoningResidue("<THINK>x</THINK>")).toBe(true);
		expect(hasReasoningResidue("< think >x")).toBe(true);
		expect(hasReasoningResidue("</  Thinking >")).toBe(true);
	});

	it("allows ordinary prose and unrelated markup", () => {
		expect(
			hasReasoningResidue("I thought about it and analysis is done."),
		).toBe(false);
		expect(hasReasoningResidue("<b>bold</b> <div>x</div>")).toBe(false);
		expect(hasReasoningResidue("")).toBe(false);
	});

	it("returns the same verdict on repeated calls with identical input", () => {
		// Regression for the documented `g`-flag hazard: a global regex would
		// retain lastIndex here and alternate true/false.
		const text = "leak <thinking>secret</thinking>";
		const verdicts = [
			hasReasoningResidue(text),
			hasReasoningResidue(text),
			hasReasoningResidue(text),
			hasReasoningResidue(text),
		];
		expect(verdicts).toEqual([true, true, true, true]);
	});

	it("does not treat a tag name embedded in a longer word as residue", () => {
		expect(hasReasoningResidue("<thinktank>")).toBe(false);
		expect(hasReasoningResidue("<reasoningengine>")).toBe(false);
	});
});

describe("stripReasoningPrefixes", () => {
	it("removes everything through the last completed close tag", () => {
		expect(stripReasoningPrefixes("<think>a</think>visible")).toBe("visible");
		expect(
			stripReasoningPrefixes("<think>a</think><analysis>b</analysis>answer"),
		).toBe("answer");
	});

	it("preserves an unmatched opening tag so later gates still fail closed", () => {
		const text = "<think>never closed";
		expect(stripReasoningPrefixes(text)).toBe(text);
		expect(hasReasoningResidue(stripReasoningPrefixes(text))).toBe(true);
	});

	it("returns text unchanged when there is no reasoning markup", () => {
		expect(stripReasoningPrefixes("plain answer")).toBe("plain answer");
	});
});

describe("findNextOpenTag / findNextCloseTag", () => {
	it("locates a well-formed open tag and reports the span past its '>'", () => {
		const match = findNextOpenTag("xx<think>yy", 0, ALT);
		expect(match).toEqual({ start: 2, end: 9, closing: false });
	});

	it("reports no match for an open tag whose '>' never arrives", () => {
		expect(findNextOpenTag("xx<think attr", 0, ALT)).toBeNull();
	});

	it("locates a close tag that carries only whitespace before '>'", () => {
		const match = findNextCloseTag("a</think   >b", 0, ALT);
		expect(match?.closing).toBe(true);
		expect("a</think   >".length).toBe(match?.end);
	});

	it("rejects a close tag carrying attributes", () => {
		expect(findNextCloseTag("a</think attr>b", 0, ALT)).toBeNull();
	});

	it("honours the `from` offset", () => {
		expect(findNextOpenTag("<think></think><think>", 1, ALT)?.start).toBe(15);
	});
});

describe("stripPairedTagBlocks", () => {
	it("removes a complete pair and keeps surrounding text", () => {
		expect(stripPairedTagBlocks("a<think>x</think>b", ALT)).toBe("ab");
	});

	it("pairs an open with the nearest later close, collapsing nested markup", () => {
		expect(
			stripPairedTagBlocks("a<think>1<analysis>2</analysis>3</think>b", ALT),
		).toBe("a3</think>b");
	});

	it("leaves a dangling open after the last close untouched", () => {
		expect(stripPairedTagBlocks("a<think>x</think>b<think>tail", ALT)).toBe(
			"ab<think>tail",
		);
	});

	it("returns text unchanged when no close tag exists", () => {
		expect(stripPairedTagBlocks("a<think>x", ALT)).toBe("a<think>x");
	});
});

describe("stripUnclosedTagSuffix", () => {
	it("drops a trailing unmatched open tag and everything after it", () => {
		expect(stripUnclosedTagSuffix("keep me<think>drop me", ALT)).toBe(
			"keep me",
		);
	});

	it("is a no-op when the open tag never terminates", () => {
		expect(stripUnclosedTagSuffix("keep me<think drop", ALT)).toBe(
			"keep me<think drop",
		);
	});
});

describe("malformed-residue scanning stays bounded", () => {
	it("completes promptly on a long run of unterminated tag candidates", () => {
		// The quadratic shape the module's indexOf/whitespace-walk design removes.
		const hostile = `${"<think ".repeat(20_000)}no terminator anywhere`;
		const started = Date.now();
		expect(findNextOpenTag(hostile, 0, ALT)).toBeNull();
		expect(findNextCloseTag(hostile, 0, ALT)).toBeNull();
		expect(stripPairedTagBlocks(hostile, ALT)).toBe(hostile);
		expect(hasReasoningResidue(hostile)).toBe(true);
		expect(Date.now() - started).toBeLessThan(2_000);
	});
});
