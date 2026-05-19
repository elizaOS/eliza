import { describe, expect, test } from "vitest";
import {
	deleteGraphemeBackward,
	deleteGraphemeForward,
	deleteToLineEnd,
	deleteToLineStart,
	deleteWordBackward,
	hasControlChars,
	insertTextAtCursor,
	isControlChar,
	moveCursorLeft,
	moveCursorRight,
	moveWordBackwards,
	moveWordForwards,
} from "../src/utils/cursor-movement.js";

describe("cursor movement utilities", () => {
	describe("moveCursorLeft", () => {
		test("moves cursor left by one character", () => {
			expect(moveCursorLeft("hello", 3)).toBe(2);
		});

		test("stops at beginning of string", () => {
			expect(moveCursorLeft("hello", 0)).toBe(0);
		});

		test("handles emoji as single grapheme", () => {
			const text = "hi👋bye";
			// From after the emoji
			const cursor = 4; // After "hi👋"
			// Should move back one grapheme (the emoji)
			const newCursor = moveCursorLeft(text, cursor);
			expect(newCursor).toBe(2); // Before the emoji
		});
	});

	describe("moveCursorRight", () => {
		test("moves cursor right by one character", () => {
			expect(moveCursorRight("hello", 2)).toBe(3);
		});

		test("stops at end of string", () => {
			expect(moveCursorRight("hello", 5)).toBe(5);
		});

		test("handles emoji as single grapheme", () => {
			const text = "hi👋bye";
			// From before the emoji
			const cursor = 2; // After "hi", before emoji
			// Should move forward one grapheme (the emoji)
			const newCursor = moveCursorRight(text, cursor);
			expect(newCursor).toBe(4); // After emoji
		});
	});

	describe("moveWordBackwards", () => {
		test("moves to start of previous word", () => {
			expect(moveWordBackwards("hello world", 11)).toBe(6);
		});

		test("skips whitespace", () => {
			expect(moveWordBackwards("hello   world", 8)).toBe(0);
		});

		test("handles punctuation", () => {
			expect(moveWordBackwards("hello, world", 12)).toBe(7);
		});

		test("stops at beginning", () => {
			expect(moveWordBackwards("hello", 0)).toBe(0);
		});
	});

	describe("moveWordForwards", () => {
		test("moves to end of current/next word", () => {
			// moveWordForwards moves to the END of the next word
			expect(moveWordForwards("hello world", 0)).toBe(5); // End of "hello"
		});

		test("skips whitespace then moves to end of word", () => {
			// From after "hello" (position 5), skip spaces, move to end of "world"
			expect(moveWordForwards("hello   world", 5)).toBe(13); // End of "world"
		});

		test("handles punctuation", () => {
			// From position 5 (after "hello"), we hit comma which is punctuation
			// So we skip the punctuation run (just the comma)
			expect(moveWordForwards("hello, world", 5)).toBe(6); // End of punctuation run
		});

		test("stops at end", () => {
			expect(moveWordForwards("hello", 5)).toBe(5);
		});
	});

	describe("deleteGraphemeBackward", () => {
		test("deletes character before cursor", () => {
			const result = deleteGraphemeBackward("hello", 3);
			expect(result.text).toBe("helo");
			expect(result.cursor).toBe(2);
		});

		test("does nothing at beginning", () => {
			const result = deleteGraphemeBackward("hello", 0);
			expect(result.text).toBe("hello");
			expect(result.cursor).toBe(0);
		});

		test("handles emoji as single unit", () => {
			const text = "hi👋bye";
			const result = deleteGraphemeBackward(text, 4);
			expect(result.text).toBe("hibye");
			expect(result.cursor).toBe(2);
		});
	});

	describe("deleteGraphemeForward", () => {
		test("deletes character at cursor", () => {
			const result = deleteGraphemeForward("hello", 2);
			expect(result.text).toBe("helo");
			expect(result.cursor).toBe(2);
		});

		test("does nothing at end", () => {
			const result = deleteGraphemeForward("hello", 5);
			expect(result.text).toBe("hello");
			expect(result.cursor).toBe(5);
		});
	});

	describe("deleteWordBackward", () => {
		test("deletes word before cursor", () => {
			const result = deleteWordBackward("hello world", 11);
			expect(result.text).toBe("hello ");
			expect(result.cursor).toBe(6);
		});

		test("deletes word and whitespace", () => {
			const result = deleteWordBackward("hello world", 6);
			expect(result.text).toBe("world");
			expect(result.cursor).toBe(0);
		});
	});

	describe("deleteToLineStart", () => {
		test("deletes from cursor to line start", () => {
			const result = deleteToLineStart("hello world", 6);
			expect(result.text).toBe("world");
			expect(result.cursor).toBe(0);
		});

		test("does nothing at beginning", () => {
			const result = deleteToLineStart("hello", 0);
			expect(result.text).toBe("hello");
			expect(result.cursor).toBe(0);
		});
	});

	describe("deleteToLineEnd", () => {
		test("deletes from cursor to line end", () => {
			const result = deleteToLineEnd("hello world", 5);
			expect(result.text).toBe("hello");
			expect(result.cursor).toBe(5);
		});

		test("does nothing at end", () => {
			const result = deleteToLineEnd("hello", 5);
			expect(result.text).toBe("hello");
			expect(result.cursor).toBe(5);
		});
	});

	describe("insertTextAtCursor", () => {
		test("inserts text at cursor position", () => {
			const result = insertTextAtCursor("helo", 2, "l");
			expect(result.text).toBe("hello");
			expect(result.cursor).toBe(3);
		});

		test("inserts at beginning", () => {
			const result = insertTextAtCursor("ello", 0, "h");
			expect(result.text).toBe("hello");
			expect(result.cursor).toBe(1);
		});

		test("inserts at end", () => {
			const result = insertTextAtCursor("hell", 4, "o");
			expect(result.text).toBe("hello");
			expect(result.cursor).toBe(5);
		});

		test("inserts multiple characters", () => {
			const result = insertTextAtCursor("ho", 1, "ell");
			expect(result.text).toBe("hello");
			expect(result.cursor).toBe(4);
		});
	});

	describe("isControlChar", () => {
		test("identifies control characters", () => {
			expect(isControlChar("\x00")).toBe(true);
			expect(isControlChar("\x1f")).toBe(true);
			expect(isControlChar("\x7f")).toBe(true);
		});

		test("identifies regular characters as not control", () => {
			expect(isControlChar("a")).toBe(false);
			expect(isControlChar("Z")).toBe(false);
			expect(isControlChar(" ")).toBe(false);
			expect(isControlChar("5")).toBe(false);
		});
	});

	describe("hasControlChars", () => {
		test("detects control characters in string", () => {
			expect(hasControlChars("hello\x00world")).toBe(true);
			expect(hasControlChars("\x1b[0m")).toBe(true);
		});

		test("returns false for normal strings", () => {
			expect(hasControlChars("hello world")).toBe(false);
			expect(hasControlChars("")).toBe(false);
		});
	});
});
