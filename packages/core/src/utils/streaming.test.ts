import { describe, expect, it } from "vitest";
import { ResponseSkeletonStreamExtractor } from "./streaming";

const skeleton = {
	spans: [
		{ kind: "literal" as const, value: '{"shouldRespond":' },
		{ kind: "free-string" as const, key: "shouldRespond" },
		{ kind: "literal" as const, value: ',"replyText":' },
		{ kind: "free-string" as const, key: "replyText" },
		{ kind: "literal" as const, value: "}" },
	],
};
const head = '{"shouldRespond":"RESPOND","replyText":"';

function run(pushes: string[]) {
	const chunks: string[] = [];
	const accumulated: string[] = [];
	const extractor = new ResponseSkeletonStreamExtractor({
		skeleton,
		streamFields: ["replyText"],
		onChunk: (chunk, _field, acc) => {
			chunks.push(chunk);
			if (acc !== undefined) accumulated.push(acc);
		},
	});
	for (const push of pushes) extractor.push(push);
	extractor.flush();
	for (const value of [...chunks, ...accumulated]) {
		expect(value.isWellFormed()).toBe(true);
	}
	return { text: chunks.join(""), final: accumulated.at(-1) };
}

describe("ResponseSkeletonStreamExtractor surrogate pairs (#30904)", () => {
	it.each([
		["an escaped pair", [`${head}Hi \\ud83d\\ude00!"}`], "Hi \u{1f600}!"],
		[
			"a literal pair split across pushes",
			[`${head}Hi \ud83d`, '\ude00!"}'],
			"Hi \u{1f600}!",
		],
		["a lone trailing high surrogate", [`${head}Hi \\ud83d"}`], "Hi �"],
		["an interior lone high surrogate", [`${head}A\\ud83dB"}`], "A�B"],
		["an isolated low surrogate", [`${head}A\\ude00B"}`], "A�B"],
	])("emits well-formed chunks for %s", (_label, pushes, expected) => {
		expect(run(pushes)).toEqual({ text: expected, final: expected });
	});

	it.each([
		[
			"a literal pair split across pushes",
			["Hi \ud83d", "\ude00!"],
			"Hi \u{1f600}!",
		],
		["a lone high surrogate at end-of-stream", ["Hi \ud83d"], "Hi �"],
	])(
		"emits well-formed passthrough prose for %s",
		(_label, pushes, expected) => {
			expect(run(pushes)).toEqual({ text: expected, final: expected });
		},
	);
});
