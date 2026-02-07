import { describe, expect, test } from "vitest";
import {
	cleanPasteForMultiLine,
	cleanPasteForSingleLine,
	PASTE_END,
	PasteHandler,
	PASTE_START,
} from "../src/utils/paste-handler.js";

describe("paste handler utilities", () => {
	describe("PasteHandler", () => {
		test("handles simple paste", () => {
			const handler = new PasteHandler();
			const result = handler.handleInput(`${PASTE_START}hello${PASTE_END}`);
			expect(result.consumed).toBe(true);
			expect(result.pasteContent).toBe("hello");
			expect(result.remaining).toBe("");
		});

		test("handles paste split across multiple inputs", () => {
			const handler = new PasteHandler();

			// First part - start of paste
			const result1 = handler.handleInput(`${PASTE_START}hel`);
			expect(result1.consumed).toBe(true);
			expect(result1.pasteContent).toBeNull();
			expect(handler.isBuffering()).toBe(true);

			// Second part - end of paste
			const result2 = handler.handleInput(`lo${PASTE_END}`);
			expect(result2.consumed).toBe(true);
			expect(result2.pasteContent).toBe("hello");
			expect(handler.isBuffering()).toBe(false);
		});

		test("returns remaining data after paste end", () => {
			const handler = new PasteHandler();
			const result = handler.handleInput(`${PASTE_START}hello${PASTE_END}extra`);
			expect(result.consumed).toBe(true);
			expect(result.pasteContent).toBe("hello");
			expect(result.remaining).toBe("extra");
		});

		test("passes through non-paste input", () => {
			const handler = new PasteHandler();
			const result = handler.handleInput("normal input");
			expect(result.consumed).toBe(false);
			expect(result.pasteContent).toBeNull();
			expect(result.remaining).toBe("normal input");
		});

		test("reset clears buffer", () => {
			const handler = new PasteHandler();
			handler.handleInput(`${PASTE_START}partial`);
			expect(handler.isBuffering()).toBe(true);
			handler.reset();
			expect(handler.isBuffering()).toBe(false);
		});
	});

	describe("cleanPasteForSingleLine", () => {
		test("removes newlines", () => {
			expect(cleanPasteForSingleLine("hello\nworld")).toBe("helloworld");
		});

		test("removes carriage returns", () => {
			expect(cleanPasteForSingleLine("hello\r\nworld")).toBe("helloworld");
		});

		test("preserves tabs", () => {
			// cleanPasteForSingleLine only removes line endings, not tabs
			expect(cleanPasteForSingleLine("hello\tworld")).toBe("hello\tworld");
		});

		test("preserves regular text", () => {
			expect(cleanPasteForSingleLine("hello world")).toBe("hello world");
		});

		test("handles empty string", () => {
			expect(cleanPasteForSingleLine("")).toBe("");
		});
	});

	describe("cleanPasteForMultiLine", () => {
		test("normalizes line endings", () => {
			expect(cleanPasteForMultiLine("hello\r\nworld")).toBe("hello\nworld");
		});

		test("preserves tabs", () => {
			// cleanPasteForMultiLine only normalizes line endings, not tabs
			expect(cleanPasteForMultiLine("hello\tworld")).toBe("hello\tworld");
		});

		test("preserves newlines", () => {
			expect(cleanPasteForMultiLine("hello\nworld")).toBe("hello\nworld");
		});

		test("handles multiple line endings", () => {
			expect(cleanPasteForMultiLine("a\r\nb\r\nc")).toBe("a\nb\nc");
		});
	});

	describe("constants", () => {
		test("PASTE_START is correct escape sequence", () => {
			expect(PASTE_START).toBe("\x1b[200~");
		});

		test("PASTE_END is correct escape sequence", () => {
			expect(PASTE_END).toBe("\x1b[201~");
		});
	});
});
