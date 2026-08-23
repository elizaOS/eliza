import { describe, expect, it } from "vitest";
import {
	extractGenerateTextContentText,
	getV5ModelText,
} from "./generate-text-result.ts";

describe("getV5ModelText", () => {
	it("passes through strings", () => {
		expect(getV5ModelText("plain")).toBe("plain");
	});

	it("prefers non-empty top-level text", () => {
		expect(getV5ModelText({ text: "hi" } as never)).toBe("hi");
	});

	it("falls back to content text parts", () => {
		const raw = {
			content: [
				{ type: "text", text: "a" },
				{ type: "output_text", text: "b" },
			],
		} as never;
		expect(getV5ModelText(raw)).toBe("ab");
	});

	it("falls back to the response field", () => {
		expect(getV5ModelText({ response: "resp" } as never)).toBe("resp");
	});

	it("never returns undefined", () => {
		expect(getV5ModelText({} as never)).toBe("{}");
		expect(getV5ModelText({ text: "" } as never)).not.toBeUndefined();
	});
});

describe("extractGenerateTextContentText", () => {
	it("joins text and output_text parts", () => {
		const content = [
			{ type: "text", text: "x" },
			{ type: "output_text", text: "y" },
			{ type: "image", text: "ignored" },
		];
		expect(extractGenerateTextContentText({ content } as never)).toBe("xy");
	});

	it("handles part.content string form", () => {
		const content = [{ type: "text", content: "z" }];
		expect(extractGenerateTextContentText({ content } as never)).toBe("z");
	});

	it("returns empty for missing or non-array content", () => {
		expect(extractGenerateTextContentText({} as never)).toBe("");
		expect(extractGenerateTextContentText({ content: "str" } as never)).toBe(
			"str",
		);
	});
});
