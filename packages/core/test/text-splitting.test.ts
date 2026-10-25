import { describe, expect, it } from "vitest";
import {
	createFirstSentenceStreamTracker,
	extractFirstSentence,
} from "../src/utils/text-splitting.ts";

const cjkSentences = [
	["我已经设置好了提醒。", "现在继续。"],
	["設定が完了しました。", "次へ進みます。"],
	["请问需要帮助吗？", "我可以继续。"],
	["設定が完了しました！", "次へ進みます。"],
	["「設定が完了しました。」", "次へ進みます。"],
	["『設定が完了しました！』", "次へ進みます。"],
	["（設定が完了しました。）", "次へ進みます。"],
	["我已经设置好了提醒。", ""],
	["設定が完了しました。", ""],
	["真的吗？！", "太好了。"],
	["まだ考え中。。。", "次へ進みます。"],
	["「真的吗？！」", "太好了。"],
	["『まだ考え中。。。』", "次へ進みます。"],
	["真的吗？！", ""],
	["まだ考え中。。。", ""],
] as const;

const asciiSentences = [
	["Your reminder is set.", " Next step."],
	["Dr. Smith arrives at 9 a.m. tomorrow.", " Please be ready."],
	["Is it 9 a.m.?", " Yes, it is."],
	["Is it 9 p.m.?", " Yes, it is."],
	["The value is 3.14.", " Keep it."],
	['He said "The reminder is set."', " Next step."],
	["Wait...", " Next step."],
	["The appointment is at 9 p.m.", ""],
] as const;

describe("first-sentence boundaries", () => {
	it.each([...cjkSentences, ...asciiSentences])(
		"keeps the first sentence %s across every two-chunk split",
		(first, rest) => {
			const text = first + rest;
			expect(extractFirstSentence(text)).toEqual({
				first,
				rest: rest.trim(),
				complete: true,
			});
			for (let split = 0; split <= text.length; split += 1) {
				const tracker = createFirstSentenceStreamTracker();
				const prefix = text.slice(0, split);
				let boundary = tracker.push(prefix, prefix, 1);
				boundary = tracker.push(text.slice(split), text, 1) ?? boundary;
				boundary = tracker.finish() ?? boundary;
				expect(boundary, `split ${split}: ${text}`).toBe(first.length);
			}
		},
	);

	it("waits for a terminator run and closer in later chunks", () => {
		const tracker = createFirstSentenceStreamTracker();
		let accumulated = "";
		for (const chunk of ["「真的吗？", "！", "」"]) {
			accumulated += chunk;
			expect(tracker.push(chunk, accumulated, 1)).toBeUndefined();
		}
		expect(tracker.push("太好了。", `${accumulated}太好了。`, 1)).toBe(
			accumulated.length,
		);
	});

	it("keeps a run intact when each character arrives separately", () => {
		for (const [first, rest] of cjkSentences) {
			const tracker = createFirstSentenceStreamTracker();
			let accumulated = "";
			let boundary: number | undefined;
			for (const chunk of first + rest) {
				accumulated += chunk;
				boundary = tracker.push(chunk, accumulated, 1) ?? boundary;
			}
			expect(tracker.finish() ?? boundary).toBe(first.length);
		}
	});

	it("does not complete an unfinished sentence", () => {
		const text = "A sentence with no terminator";
		expect(extractFirstSentence(text)).toEqual({
			first: text,
			rest: "",
			complete: false,
		});
		const tracker = createFirstSentenceStreamTracker();
		expect(tracker.push(text, text, 1)).toBeUndefined();
		expect(tracker.finish()).toBeUndefined();
	});
});
