/**
 * Pins getV5ModelText and extractGenerateTextContentText normalization across the
 * provider-boundary shapes real adapters return — raw string, text field, string
 * or part-array content, and response-only payload — so typed access to
 * GenerateTextResult's content/response fields keeps working without unsafe casts.
 */
import { describe, expect, it } from "vitest";
import type { GenerateTextResult } from "../../types/model";
import {
	extractGenerateTextContentText,
	getV5ModelText,
} from "./generate-text-result";

describe("getV5ModelText (#9155 boundary normalization)", () => {
	it("returns a raw string passthrough", () => {
		expect(getV5ModelText("hello")).toBe("hello");
	});

	it("prefers a non-empty text field", () => {
		const raw: GenerateTextResult = { text: "from text" };
		expect(getV5ModelText(raw)).toBe("from text");
	});

	it("falls back to a string content field when text is empty", () => {
		const raw: GenerateTextResult = { text: "", content: "from content" };
		expect(getV5ModelText(raw)).toBe("from content");
	});

	it("joins text parts from a content part-array", () => {
		const raw: GenerateTextResult = {
			text: "",
			content: [
				{ type: "text", text: "hello " },
				{ type: "output_text", text: "world" },
				{ type: "image", text: "ignored-non-text-part" },
			],
		};
		expect(getV5ModelText(raw)).toBe("hello world");
	});

	it("reads a part's content field when text is absent", () => {
		const raw: GenerateTextResult = {
			text: "",
			content: [{ type: "text", content: "via content" }],
		};
		expect(getV5ModelText(raw)).toBe("via content");
	});

	it("falls back to a response-only payload", () => {
		const raw: GenerateTextResult = { text: "", response: "from response" };
		expect(getV5ModelText(raw)).toBe("from response");
	});
});

describe("extractGenerateTextContentText (#9155)", () => {
	it("returns empty string when there is no content", () => {
		expect(extractGenerateTextContentText({ text: "x" })).toBe("");
	});

	it("returns a flat string content directly", () => {
		expect(extractGenerateTextContentText({ text: "", content: "flat" })).toBe(
			"flat",
		);
	});

	it("skips parts whose type is not a text type", () => {
		const raw: GenerateTextResult = {
			text: "",
			content: [
				{ type: "reasoning", text: "skip" },
				{ type: "text", text: "keep" },
			],
		};
		expect(extractGenerateTextContentText(raw)).toBe("keep");
	});
});
