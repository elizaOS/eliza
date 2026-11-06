import { expect, it } from "vitest";
import { ResponseSkeletonStreamExtractor } from "../src/utils/streaming";

function streamUnordered(
	wire: string,
	cuts: number[] = [],
	streamFields = ["text"],
): string {
	let actual = "";
	const extractor = new ResponseSkeletonStreamExtractor({
		skeleton: { spans: [] },
		streamFields,
		unordered: true,
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

it("nested text key must not leak into the top-level reply", () => {
	const wire = `{"meta": {"text": "nested"}, "text": "real"}`;
	expect(streamUnordered(wire, [])).toBe("real");
	expect(streamUnordered(wire, [15, 30])).toBe("real");
	expect(streamUnordered(wire, [25])).toBe("real");
});

it("action parameter text must not leak into the top-level reply", () => {
	const wire = `{"thought":"plan","actions":[{"name":"SEND_MESSAGE","parameters":{"text":"nested hello"}}],"text":"real reply"}`;
	expect(streamUnordered(wire, [])).toBe("real reply");
	expect(streamUnordered(wire, [30, 70])).toBe("real reply");
	expect(streamUnordered(wire, [10, 45, 80, 100])).toBe("real reply");
});

it("edge cases", () => {
	// Key inside a string value.
	expect(
		streamUnordered(`{"thought": "the \\"text\\" key", "text": "real"}`),
	).toBe("real");
	// Non-string top-level field before the text field.
	expect(streamUnordered(`{"shouldRespond": false, "text": "real"}`)).toBe(
		"real",
	);
	// Non-string nested object before the text field.
	expect(streamUnordered(`{"meta": {"count": 3}, "text": "real"}`)).toBe(
		"real",
	);
	// Top-level text first, nested text after.
	expect(streamUnordered(`{"text": "real", "meta": {"text": "nested"}}`)).toBe(
		"real",
	);
	// Nested array value with a text key inside an array item.
	expect(
		streamUnordered(
			`{"items": [{"text": "a"}, {"text": "b"}], "text": "real"}`,
		),
	).toBe("real");
	// Two stream fields, nested copy of the second one.
	expect(
		streamUnordered(
			`{"meta": {"messageToUser": "no"}, "messageToUser": "yes", "text": "real"}`,
			[],
			["text", "messageToUser"],
		),
	).toBe("yesreal");
	// Truncated stream: nested text only, no top-level text.
	expect(streamUnordered(`{"meta": {"text": "nested"}}`)).toBe("");
});

it("every single cut point of the nested wires", () => {
	const wires = [
		[`{"meta": {"text": "nested"}, "text": "real"}`, "real"],
		[
			`{"thought":"plan","actions":[{"name":"SEND_MESSAGE","parameters":{"text":"nested hello"}}],"text":"real reply"}`,
			"real reply",
		],
	] as const;
	for (const [wire, expected] of wires) {
		for (let cut = 1; cut < wire.length; cut++) {
			expect(streamUnordered(wire, [cut])).toBe(expected);
		}
	}
});
