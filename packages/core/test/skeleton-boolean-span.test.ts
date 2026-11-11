import { describe, expect, it } from "vitest";
import { ResponseSkeletonStreamExtractor } from "../src/utils/streaming.ts";

/** Skeleton with a boolean span ahead of the streamed free-string field. */
function extractor(onChunk: (chunk: string) => void) {
	return new ResponseSkeletonStreamExtractor({
		skeleton: {
			spans: [
				{ kind: "literal", value: '{"ok":' },
				{ kind: "boolean", key: "ok" },
				{ kind: "literal", value: ', "replyText":' },
				{ kind: "free-string", key: "replyText" },
				{ kind: "literal", value: "}" },
			],
		},
		streamFields: ["replyText"],
		onChunk,
	});
}

describe("ResponseSkeletonStreamExtractor boolean span", () => {
	it("streams the reply after a boolean span in one push", () => {
		let actual = "";
		const ex = extractor((chunk) => {
			actual += chunk;
		});
		ex.push('{"ok": true, "replyText": "hi"}');
		ex.flush();
		expect(actual).toBe("hi");
	});

	it("streams the reply after a false/null span", () => {
		for (const literal of ["false", "null"]) {
			let actual = "";
			const ex = new ResponseSkeletonStreamExtractor({
				skeleton: {
					spans: [
						{ kind: "literal", value: '{"ok":' },
						{ kind: "boolean", key: "ok" },
						{ kind: "literal", value: ', "replyText":' },
						{ kind: "free-string", key: "replyText" },
						{ kind: "literal", value: "}" },
					],
				},
				streamFields: ["replyText"],
				onChunk: (chunk) => {
					actual += chunk;
				},
			});
			ex.push(`{"ok": ${literal}, "replyText": "hi"}`);
			ex.flush();
			expect(actual).toBe("hi");
		}
	});

	it("waits for a split boolean instead of consuming its prefix", () => {
		let actual = "";
		const ex = extractor((chunk) => {
			actual += chunk;
		});
		ex.push('{"ok": tr');
		ex.push('ue, "replyText": "hi"}');
		ex.flush();
		expect(actual).toBe("hi");
	});
});
