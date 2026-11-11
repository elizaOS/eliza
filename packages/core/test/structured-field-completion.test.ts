import { describe, expect, it } from "vitest";
import { StructuredFieldStreamExtractor } from "../src/utils/streaming.ts";

function extractor(
	streamFields: string[],
	onChunk: (chunk: string, field?: string) => void,
	onFieldDone?: (field: string, content: string) => void,
) {
	return new StructuredFieldStreamExtractor({
		level: 1,
		schema: [
			{ field: "thought", type: "string" },
			{ field: "replyText", type: "string" },
		] as never,
		streamFields,
		onChunk,
		onFieldDone,
	});
}

describe("StructuredFieldStreamExtractor field completion", () => {
	it("keeps continuation lines after an inline streamed value", () => {
		const chunks: string[] = [];
		const ex = extractor(["replyText"], (chunk) => {
			chunks.push(chunk);
		});
		ex.push("replyText: first part\n  second part\n");
		ex.flush();
		expect(chunks.join("")).toBe("first part\nsecond part");
		expect(ex.getValidatedFields().get("replyText")).toBe(
			"first part\nsecond part",
		);
	});

	it("marks a multiline non-streamed field complete and validated", () => {
		const done: Array<[string, string]> = [];
		const ex = extractor(
			["replyText"],
			() => {},
			(field, content) => {
				done.push([field, content]);
			},
		);
		ex.push("thought:\n  line one\n  line two\nreplyText: hi\n");
		ex.flush();
		expect(ex.diagnose().incompleteFields).toEqual([]);
		expect(ex.getValidatedFields().get("thought")).toBe("line one\nline two");
		expect(done).toContainEqual(["thought", "line one\nline two"]);
	});

	it("still completes a single-line field at once", () => {
		const chunks: string[] = [];
		const ex = extractor(["replyText"], (chunk) => {
			chunks.push(chunk);
		});
		ex.push("replyText: hi\n");
		ex.flush();
		expect(chunks).toEqual(["hi"]);
		expect(ex.diagnose()).toEqual({
			missingFields: ["thought"],
			invalidFields: [],
			incompleteFields: [],
		});
		expect(ex.getValidatedFields().get("replyText")).toBe("hi");
	});
});
