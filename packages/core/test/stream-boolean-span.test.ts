import { expect, it } from "vitest";
import { ResponseSkeletonStreamExtractor } from "../src/utils/streaming";

function runOrdered(wire: string, cuts: number[]): string {
	let actual = "";
	const extractor = new ResponseSkeletonStreamExtractor({
		skeleton: {
			spans: [
				{ kind: "literal", value: '{"ok":' },
				{ kind: "boolean", key: "ok" },
				{ kind: "literal", value: ', "text":' },
				{ kind: "free-string", key: "text" },
				{ kind: "literal", value: "}" },
			],
		},
		streamFields: ["text"],
		unordered: false,
		onChunk: (chunk) => {
			actual += chunk;
		},
	});
	let prev = 0;
	for (const cut of [...cuts, wire.length]) {
		extractor.push(wire.slice(prev, cut));
		prev = cut;
	}
	extractor.flush();
	return actual;
}

it("streams the text field after a boolean span in ordered mode", () => {
	const wire = '{"ok":true, "text":"hello world"}';
	// Whole payload at once.
	expect(runOrdered(wire, [])).toBe("hello world");
	// Split mid-boolean and mid-text: text must stream, not stall then drop.
	expect(runOrdered(wire, [7, 20])).toBe("hello world");
	expect(runOrdered(wire, [9, 15, 25])).toBe("hello world");
});

it("streams the text field after false and null spans in ordered mode", () => {
	for (const literal of ["false", "null"]) {
		const wire = `{"ok":${literal}, "text":"hello world"}`;
		expect(runOrdered(wire, [])).toBe("hello world");
	}
});
