/** Exercises whole-fence parsing at the lenient model JSON boundary. */

import { describe, expect, it } from "vitest";
import { parseJsonModelOutput } from "./json-model-output.ts";

describe("parseJsonModelOutput", () => {
	it("parses compact unlabeled fenced JSON scalars", () => {
		expect(parseJsonModelOutput("```true```")).toBe(true);
	});

	describe("private-reasoning preamble", () => {
		// A reasoning preamble is matched with the shared reasoning-tags
		// vocabulary, not an exact lowercase `<think>` literal: models use several
		// tag names, vary the case, and sometimes emit a dangling close tag with
		// no open of its own (the evaluator's `None</think>` repair, #20080).
		it.each([
			["paired <think>", '<think>r</think>{"a":1}'],
			[
				"a brace inside the reasoning body",
				'<think>maybe {a:1}?</think>{"a":1}',
			],
			["close-only residue with no open tag", 'None</think>{"a":1}'],
			["<thinking>", '<thinking>r</thinking>{"a":1}'],
			["<reasoning>", '<reasoning>r</reasoning>{"a":1}'],
			["<analysis>", '<analysis>r</analysis>{"a":1}'],
			["<reflection>", '<reflection>r</reflection>{"a":1}'],
			["an upper-case tag", '<THINK>r</THINK>{"a":1}'],
			["whitespace inside the tags", '< think >r</ think >{"a":1}'],
			["visible prose before the block", 'Sure!\n<think>r</think>{"a":1}'],
			[
				"a preamble ahead of a code fence",
				'<think>r</think>```json\n{"a":1}\n```',
			],
		])("strips %s", (_label, raw) => {
			expect(parseJsonModelOutput(raw)).toEqual({ a: 1 });
		});

		it("strips a preamble ahead of an array payload", () => {
			expect(parseJsonModelOutput("<think>r</think>[1,2]")).toEqual([1, 2]);
		});

		// The strip is anchored to the head of the candidate because reasoning
		// markup is also ordinary string data. Stripping inside a payload would
		// silently rewrite a value or break the parse, which is strictly worse
		// than leaving a preamble in place.
		it.each([
			[
				"a tag pair inside a string value",
				'{"text":"<think>hi</think>"}',
				{ text: "<think>hi</think>" },
			],
			[
				"a close tag inside a string value",
				'{"a":1,"note":"</think> x"}',
				{ a: 1, note: "</think> x" },
			],
			[
				"an open tag inside a string value",
				'{"prompt":"use <thinking> tags"}',
				{ prompt: "use <thinking> tags" },
			],
			[
				"a close tag inside a fenced body",
				'```json\n{"n":"</think>"}\n```',
				{ n: "</think>" },
			],
			[
				"a key named after a reasoning tag",
				'{"analysis":"ok"}',
				{ analysis: "ok" },
			],
		])("leaves %s untouched", (_label, raw, expected) => {
			expect(parseJsonModelOutput(raw)).toEqual(expected);
		});

		it("keeps an unmatched open tag so the parse fails closed", () => {
			// Deleting only the open tag would turn a private payload into
			// apparently-clean output; `reasoning-tags.ts` documents the same rule.
			expect(parseJsonModelOutput('<think>never closed {"a":1}')).toBeNull();
		});
	});
});
