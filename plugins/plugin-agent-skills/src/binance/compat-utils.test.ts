/**
 * Tests for {@link extractCompatTextContent} — the content-shape normalizer
 * feeding the Binance direct-skill fast path. Drives the real pure function
 * over every accepted message-content shape (plain string, text-part array,
 * `{ text }` object) plus malformed inputs, asserting the exact concatenated
 * output each shape produces. Deterministic; no mocks.
 */

import { describe, expect, it } from "vitest";
import { extractCompatTextContent } from "./compat-utils";

describe("extractCompatTextContent", () => {
	describe("string content passes through verbatim", () => {
		it("returns a plain string unchanged", () => {
			expect(extractCompatTextContent("buy 0.5 BTC")).toBe("buy 0.5 BTC");
		});

		it("preserves an empty string instead of coercing it away", () => {
			expect(extractCompatTextContent("")).toBe("");
		});
	});

	describe("text-part arrays", () => {
		it("joins text parts in order without separators", () => {
			const content = [
				{ type: "text", text: "hello, " },
				{ type: "text", text: "world" },
			];
			expect(extractCompatTextContent(content)).toBe("hello, world");
		});

		it("includes parts that carry no explicit type field", () => {
			const content = [{ text: "no type declared" }];
			expect(extractCompatTextContent(content)).toBe("no type declared");
		});

		it("skips parts typed as something other than text", () => {
			const content = [
				{ type: "text", text: "keep " },
				{ type: "image", text: "binary-prompt-leak" },
				{ type: "tool_call", text: "ignored" },
			];
			expect(extractCompatTextContent(content)).toBe("keep ");
		});

		it("skips entries whose type field is not a string", () => {
			const content = [{ type: 7, text: "untyped-by-type" }];
			expect(extractCompatTextContent(content)).toBe("untyped-by-type");
		});

		it("skips non-object entries inside the array", () => {
			const content = [
				null,
				42,
				true,
				"raw string part",
				{ type: "text", text: "only this" },
			];
			expect(extractCompatTextContent(content)).toBe("only this");
		});

		it("drops empty-string text parts but keeps surrounding ones", () => {
			const content = [
				{ type: "text", text: "before" },
				{ type: "text", text: "" },
				{ type: "text", text: "after" },
			];
			expect(extractCompatTextContent(content)).toBe("beforeafter");
		});

		it("skips parts whose text field is not a string", () => {
			const content = [
				{ type: "text", text: 99 },
				{ type: "text", text: null },
				{ type: "text", text: "kept" },
			];
			expect(extractCompatTextContent(content)).toBe("kept");
		});

		it("returns an empty string when no entry contributes text", () => {
			expect(
				extractCompatTextContent([{ type: "image" }, null, "stray"]),
			).toBe("");
		});
	});

	describe("object content with a text field", () => {
		it("returns a string text field verbatim", () => {
			expect(extractCompatTextContent({ text: "solo body" })).toBe(
				"solo body",
			);
		});

		it("returns an empty string when text is not a string", () => {
			expect(extractCompatTextContent({ text: 1234 })).toBe("");
			expect(extractCompatTextContent({ text: null })).toBe("");
		});

		it("returns an empty string when the object has no text field", () => {
			expect(extractCompatTextContent({ role: "user" })).toBe("");
		});

		it("does not recurse into nested objects", () => {
			expect(
				extractCompatTextContent({ text: { text: "nested" } }),
			).toBe("");
		});
	});

	describe("unsupported shapes normalize to empty string", () => {
		it.each([null, undefined, 0, 7, false, true])(
			"maps %p to an empty string",
			(content) => {
				expect(extractCompatTextContent(content)).toBe("");
			},
		);
	});
});
