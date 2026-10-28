import { expect, it } from "vitest";
import { ResponseSkeletonStreamExtractor } from "../src/utils/streaming";

it("finishes truncated streamed strings without losing decoded text", () => {
	const cases = [
		["", ""],
		["hello", "hello"],
		["hello\\", "hello"],
		["hello\\u", "hello"],
		["hello\\u12", "hello"],
		["\\u0041\\ud83d\\ude00", "A😀"],
		["\\ud83d", "�"],
		["<think>private</think>visible", "visible"],
	] as const;
	for (const unordered of [false, true]) {
		for (const [tail, expected] of cases) {
			const wire = `{"replyText":"${tail}`;
			for (let cut = 1; cut < wire.length; cut++) {
				let actual = "";
				const extractor = new ResponseSkeletonStreamExtractor({
					skeleton: {
						spans: [
							{ kind: "literal", value: '{"replyText":' },
							{ kind: "free-string", key: "replyText" },
							{ kind: "literal", value: "}" },
						],
					},
					streamFields: ["replyText"],
					unordered,
					onChunk: (chunk) => {
						actual += chunk;
					},
				});
				extractor.push(wire.slice(0, cut));
				extractor.push(wire.slice(cut));
				extractor.flush();
				expect(extractor.done).toBe(true);
				expect(actual).toBe(expected);
				extractor.flush();
				expect(actual).toBe(expected);
			}
		}
	}
});
