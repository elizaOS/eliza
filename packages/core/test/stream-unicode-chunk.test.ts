import { expect, it } from "vitest";
import { ResponseSkeletonStreamExtractor } from "../src/utils/streaming";

it("decodes Unicode escapes across every response chunk boundary", () => {
	const wire = '{"replyText":"\\u0041\\ud83d\\ude00"}';
	for (const unordered of [false, true]) {
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
			expect(actual).toBe(JSON.parse(wire).replyText);
		}
	}
});
