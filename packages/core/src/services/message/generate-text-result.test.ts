import { describe, expect, it } from "vitest";
import type { GenerateTextResult } from "../../types/model";
import {
	extractGenerateTextContentText,
	getV5ModelText,
} from "./generate-text-result";

describe("getV5ModelText", () => {
	it("returns a plain string input unchanged", () => {
		expect(getV5ModelText("hello world")).toBe("hello world");
	});

	it("prefers a non-empty text field", () => {
		const raw: GenerateTextResult = { text: "from text", response: "ignored" };
		expect(getV5ModelText(raw)).toBe("from text");
	});

	it("falls back to string content when text is empty", () => {
		const raw: GenerateTextResult = { text: "", content: "from content" };
		expect(getV5ModelText(raw)).toBe("from content");
	});

	it("falls back to part-array content when text is empty", () => {
		const raw: GenerateTextResult = {
			text: "   ",
			content: [
				{ type: "text", text: "alpha" },
				{ type: "output_text", text: " beta" },
			],
		};
		expect(getV5ModelText(raw)).toBe("alpha beta");
	});

	it("falls back to response when text and content are empty", () => {
		const raw: GenerateTextResult = { text: "", response: "from response" };
		expect(getV5ModelText(raw)).toBe("from response");
	});

	it("prefers content over response when both are present", () => {
		const raw: GenerateTextResult = {
			text: "",
			content: "from content",
			response: "from response",
		};
		expect(getV5ModelText(raw)).toBe("from content");
	});

	it("returns the (empty) text field when nothing else is usable", () => {
		const raw: GenerateTextResult = { text: "" };
		expect(getV5ModelText(raw)).toBe("");
	});

	it("stringifies the result when text is not a string", () => {
		const raw = { content: [] } as unknown as GenerateTextResult;
		expect(getV5ModelText(raw)).toBe(JSON.stringify(raw));
	});
});

describe("extractGenerateTextContentText", () => {
	it("returns string content directly", () => {
		expect(extractGenerateTextContentText({ text: "", content: "plain" })).toBe(
			"plain",
		);
	});

	it("joins text/output_text parts and skips other part types", () => {
		const raw: GenerateTextResult = {
			text: "",
			content: [
				{ type: "text", text: "a" },
				{ type: "reasoning", text: "skip-me" },
				{ type: "output_text", text: "b" },
			],
		};
		expect(extractGenerateTextContentText(raw)).toBe("ab");
	});

	it("reads a part's content field when text is absent", () => {
		const raw: GenerateTextResult = {
			text: "",
			content: [{ content: "from-part-content" }],
		};
		expect(extractGenerateTextContentText(raw)).toBe("from-part-content");
	});

	it("returns an empty string when there is no content", () => {
		expect(extractGenerateTextContentText({ text: "" })).toBe("");
	});
});
