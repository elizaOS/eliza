import { expect, it } from "vitest";
import { StructuredFieldStreamExtractor } from "../src/utils/streaming";

function extract(
	input: string,
	level: 0 | 1 | 2 | 3 = 1,
): {
	accumulated: string;
	doneValues: Map<string, string>;
	validated: Map<string, string>;
} {
	const chunks: string[] = [];
	const doneValues = new Map<string, string>();
	const extractor = new StructuredFieldStreamExtractor({
		level,
		schema: [{ field: "replyText" }, { field: "thought" }],
		streamFields: ["replyText"],
		onChunk: (_chunk, _field, accumulated) => {
			if (accumulated !== undefined) chunks.push(accumulated);
		},
		onFieldDone: (field, value) => {
			doneValues.set(field, value);
		},
	});
	extractor.push(input);
	extractor.flush();
	return {
		accumulated: chunks.at(-1) ?? "",
		doneValues,
		validated: extractor.getValidatedFields(),
	};
}

it("keeps continuation lines after an inline-valued streamed field", () => {
	const result = extract("replyText: Hello\n  continued world\nthought: x\n");
	expect(result.accumulated).toBe("Hello\ncontinued world");
	expect(result.doneValues.get("replyText")).toBe("Hello\ncontinued world");
	expect(result.validated.get("replyText")).toBe("Hello\ncontinued world");
});

it("keeps continuation lines after an inline-valued non-streamed field", () => {
	const result = extract("thought: first\n  second\nreplyText: done\n");
	expect(result.doneValues.get("thought")).toBe("first\nsecond");
	expect(result.accumulated).toBe("done");
});

it("keeps continuations when the field value arrives at level 2", () => {
	const result = extract(
		"replyText: Hello\n  continued world\nthought: x\n",
		2,
	);
	expect(result.accumulated).toBe("Hello\ncontinued world");
	expect(result.validated.get("replyText")).toBe("Hello\ncontinued world");
});

it("still completes an inline-only value at the next field boundary", () => {
	const result = extract("replyText: Hello\nthought: x\n");
	expect(result.accumulated).toBe("Hello");
	expect(result.doneValues.get("replyText")).toBe("Hello");
	expect(result.validated.get("replyText")).toBe("Hello");
});
