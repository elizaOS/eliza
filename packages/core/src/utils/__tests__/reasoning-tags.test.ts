/**
 * Deterministic unit coverage for reasoning-tags.ts — the private-reasoning tag
 * detection and stripping module. These functions form the deny gate at the
 * last user-visible boundary before model output reaches the user.
 *
 * NOTE: the open/close-tag regexes require a leading `<`. Inputs without it
 * (e.g. "thinking" with no `<") are deliberately not matches.
 */

import { describe, expect, it } from "vitest";
import {
	findNextCloseTag,
	findNextOpenTag,
	hasReasoningResidue,
	stripPairedTagBlocks,
	stripUnclosedTagSuffix,
} from "./reasoning-tags";

const TAG_ALTERNATION = "think|thinking";

describe("findNextOpenTag", () => {
	it("finds a simple open tag", () => {
		expect(findNextOpenTag("<thinking>hello", 0, TAG_ALTERNATION)).toEqual({
			start: 0,
			end: 10,
			closing: false,
		});
	});

	it("finds an open tag with whitespace before the name", () => {
		expect(findNextOpenTag("<  think>hello", 0, TAG_ALTERNATION)).toEqual({
			start: 0,
			end: 9,
			closing: false,
		});
	});

	it("finds an open tag with attributes", () => {
		expect(
			findNextOpenTag('<think depth="deep">hello', 0, TAG_ALTERNATION),
		).toEqual({ start: 0, end: 20, closing: false });
	});

	it("finds a closing=false match after a given position", () => {
		expect(findNextOpenTag("xx <thinking>y", 3, TAG_ALTERNATION)).toEqual({
			start: 3,
			end: 13,
			closing: false,
		});
	});

	it("returns null when no tag exists", () => {
		expect(findNextOpenTag("plain text", 0, TAG_ALTERNATION)).toBeNull();
	});

	it("returns null for an identifier without a leading <", () => {
		expect(findNextOpenTag("thinkinghi", 0, TAG_ALTERNATION)).toBeNull();
	});

	it("returns null for an unterminated tag (no >)", () => {
		expect(findNextOpenTag("<think", 0, TAG_ALTERNATION)).toBeNull();
	});

	it("is case-insensitive", () => {
		expect(findNextOpenTag("<ThInK>hello", 0, TAG_ALTERNATION)).not.toBeNull();
	});

	it("matches the thinking variant", () => {
		expect(findNextOpenTag("<thinking>hi", 0, TAG_ALTERNATION)).not.toBeNull();
	});
});

describe("findNextCloseTag", () => {
	it("finds a simple close tag", () => {
		expect(
			findNextCloseTag("<thinking>hi</thinking>", 0, TAG_ALTERNATION),
		).toEqual({ start: 12, end: 23, closing: true });
	});

	it("finds a close tag with whitespace before >", () => {
		expect(
			findNextCloseTag("<thinking>hi</thinking   >", 0, TAG_ALTERNATION),
		).toEqual({ start: 12, end: 26, closing: true });
	});

	it("finds a close tag with whitespace between / and name", () => {
		expect(
			findNextCloseTag("<thinking>hi<  /think>", 0, TAG_ALTERNATION),
		).toEqual({ start: 12, end: 22, closing: true });
	});

	it("returns null when no close tag exists", () => {
		expect(findNextCloseTag("plain", 0, TAG_ALTERNATION)).toBeNull();
	});

	it("returns null for an unterminated close tag", () => {
		expect(
			findNextCloseTag("<thinking>hi</think", 0, TAG_ALTERNATION),
		).toBeNull();
	});

	it("returns null for a close tag with attributes", () => {
		expect(
			findNextCloseTag("<thinking>hi</think bad>", 0, TAG_ALTERNATION),
		).toBeNull();
	});

	it("is case-insensitive", () => {
		expect(
			findNextCloseTag("<thinking>hi</ThInK>", 0, TAG_ALTERNATION),
		).not.toBeNull();
	});
});

describe("stripPairedTagBlocks", () => {
	it("removes a complete think pair", () => {
		expect(
			stripPairedTagBlocks(
				"<thinking>secret</thinking>visible",
				TAG_ALTERNATION,
			),
		).toBe("visible");
	});

	it("removes multiple complete pairs", () => {
		expect(
			stripPairedTagBlocks(
				"<thinking>a</thinking>mid<thinking>b</thinking>end",
				TAG_ALTERNATION,
			),
		).toBe("midend");
	});

	it("returns text unchanged when no close tag exists", () => {
		expect(stripPairedTagBlocks("<thinking>no close", TAG_ALTERNATION)).toBe(
			"<thinking>no close",
		);
	});

	it("returns text unchanged for plain text", () => {
		expect(stripPairedTagBlocks("plain text", TAG_ALTERNATION)).toBe(
			"plain text",
		);
	});

	it("handles non-greedy pairing leaving a trailing close", () => {
		// Inner pair collapses first; the trailing close remains unpaired.
		expect(
			stripPairedTagBlocks(
				"<thinking>a<thinking>b</thinking>c</thinking>v",
				TAG_ALTERNATION,
			),
		).toBe("c</thinking>v");
	});

	it("handles empty string", () => {
		expect(stripPairedTagBlocks("", TAG_ALTERNATION)).toBe("");
	});
});

describe("stripUnclosedTagSuffix", () => {
	it("removes trailing unclosed open tag and everything after", () => {
		expect(
			stripUnclosedTagSuffix("visible<thinking>secret", TAG_ALTERNATION),
		).toBe("visible");
	});

	it("returns text unchanged when no open tag exists", () => {
		expect(stripUnclosedTagSuffix("plain text", TAG_ALTERNATION)).toBe(
			"plain text",
		);
	});

	it("returns everything before the first open tag", () => {
		expect(
			stripUnclosedTagSuffix("keep<thinking>secret", TAG_ALTERNATION),
		).toBe("keep");
	});

	it("handles unclosed tag with attributes", () => {
		expect(
			stripUnclosedTagSuffix('visible<think depth="deep">x', TAG_ALTERNATION),
		).toBe("visible");
	});

	it("handles empty string", () => {
		expect(stripUnclosedTagSuffix("", TAG_ALTERNATION)).toBe("");
	});
});

describe("hasReasoningResidue", () => {
	it("returns true for an open thinking tag", () => {
		expect(hasReasoningResidue("<thinking>hi")).toBe(true);
	});

	it("returns false for plain text", () => {
		expect(hasReasoningResidue("plain text")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(hasReasoningResidue("")).toBe(false);
	});

	it("returns false for non-reasoning tags", () => {
		expect(hasReasoningResidue("<div>hi</div>")).toBe(false);
	});

	it("is case-insensitive", () => {
		expect(hasReasoningResidue("<ThInK>hi")).toBe(true);
		expect(hasReasoningResidue("</THINKING>hi")).toBe(true);
	});

	it("returns false for a bare terminator-less tag (no lookahead match)", () => {
		expect(hasReasoningResidue("<think")).toBe(false);
	});

	it("does not advance lastIndex (stateless)", () => {
		expect(hasReasoningResidue("<thinking>hi")).toBe(true);
		expect(hasReasoningResidue("<thinking>hi")).toBe(true);
		expect(hasReasoningResidue("<thinking>hi")).toBe(true);
	});
});
