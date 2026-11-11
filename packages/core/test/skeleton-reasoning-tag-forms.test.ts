import { describe, expect, it } from "vitest";
import { ResponseSkeletonStreamExtractor } from "../src/utils/streaming.ts";

function streamReply(wire: string, pushes?: string[]): string {
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
		onChunk: (chunk) => {
			actual += chunk;
		},
	});
	for (const push of pushes ?? [wire]) {
		extractor.push(push);
	}
	extractor.flush();
	return actual;
}

describe("ResponseSkeletonStreamExtractor reasoning-tag forms", () => {
	it("filters an open tag with a space before >", () => {
		expect(
			streamReply('{"replyText":"<think >secret</think>hello"}'),
		).toBe("hello");
	});

	it("filters an open tag with attributes", () => {
		expect(
			streamReply('{"replyText":"<think foo=\\"x\\">secret</think>hello"}'),
		).toBe("hello");
	});

	it("filters an open tag with attributes split across pushes", () => {
		expect(
			streamReply("", [
				'{"replyText":"<think foo=\\"',
				'x\\">secret</think>hello"}',
			]),
		).toBe("hello");
	});

	it("recognizes a close tag with a space before >", () => {
		expect(
			streamReply('{"replyText":"<think>secret</think >hello"}'),
		).toBe("hello");
	});

	it("does not swallow text after a self-closing tag", () => {
		expect(streamReply('{"replyText":"<think/>hello"}')).toBe("hello");
	});

	it("still filters the plain tag and keeps ordinary angle text", () => {
		expect(streamReply('{"replyText":"<think>secret</think>hello"}')).toBe(
			"hello",
		);
		expect(streamReply('{"replyText":"a < b and c > d"}')).toBe(
			"a < b and c > d",
		);
	});
});
