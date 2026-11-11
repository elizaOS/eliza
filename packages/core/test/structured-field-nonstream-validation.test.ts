/** Repro: a fully received non-stream field must count as validated. */
import { describe, expect, it } from "vitest";
import { StructuredFieldStreamExtractor } from "../src/utils/streaming";

function makeExtractor() {
	return new StructuredFieldStreamExtractor({
		level: 1,
		schema: [
			{ field: "action", type: "string" },
			{ field: "reply", type: "string" },
		],
		streamFields: ["reply"],
		onChunk: () => {},
	});
}

describe("non-stream structured fields are validated", () => {
	it("inline non-stream field appears in validated fields", () => {
		const extractor = makeExtractor();
		extractor.push('action: "jump"\nreply: hello\n');
		extractor.flush();
		const validated = extractor.getValidatedFields();
		expect(validated.get("action")).toBe("jump");
		expect(validated.get("reply")).toBe("hello");
		expect(extractor.signalRetry(1).validatedFields).toContain("action");
	});

	it("multi-line non-stream field is complete after flush", () => {
		const extractor = makeExtractor();
		extractor.push("action:\n  jump\nreply: hello\n");
		extractor.flush();
		expect(extractor.diagnose().incompleteFields).toEqual([]);
		expect(extractor.getValidatedFields().get("action")).toBe("jump");
	});

	it("empty non-stream field stays incomplete", () => {
		const extractor = makeExtractor();
		extractor.push("action:\nreply: hello\n");
		extractor.flush();
		expect(extractor.diagnose().incompleteFields).toContain("action");
		expect(extractor.getValidatedFields().has("action")).toBe(false);
	});
});
