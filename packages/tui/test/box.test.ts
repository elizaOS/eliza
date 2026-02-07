import { describe, expect, test } from "vitest";
import { Box } from "../src/components/box.js";
import { Text } from "../src/components/text.js";
import { visibleWidth } from "../src/utils.js";

describe("Box component", () => {
	describe("constructor", () => {
		test("creates empty Box with default padding", () => {
			const box = new Box();
			const lines = box.render(40);
			// Empty box returns empty array
			expect(lines).toEqual([]);
		});

		test("creates Box with custom padding", () => {
			const text = new Text("Hello", 0, 0);
			const box = new Box(2, 3);
			box.addChild(text);
			const lines = box.render(40);
			// 3 top padding + 1 content + 3 bottom padding = 7
			expect(lines.length).toBe(7);
		});
	});

	describe("addChild", () => {
		test("adds child component", () => {
			const box = new Box(0, 0);
			const text = new Text("Hello", 0, 0);
			box.addChild(text);
			const lines = box.render(40);
			expect(lines.some((l) => l.includes("Hello"))).toBe(true);
		});

		test("renders multiple children", () => {
			const box = new Box(0, 0);
			box.addChild(new Text("First", 0, 0));
			box.addChild(new Text("Second", 0, 0));
			const lines = box.render(40);
			expect(lines.some((l) => l.includes("First"))).toBe(true);
			expect(lines.some((l) => l.includes("Second"))).toBe(true);
		});
	});

	describe("removeChild", () => {
		test("removes child component", () => {
			const box = new Box(0, 0);
			const text = new Text("Hello", 0, 0);
			box.addChild(text);
			box.removeChild(text);
			const lines = box.render(40);
			expect(lines).toEqual([]);
		});

		test("ignores non-existent child", () => {
			const box = new Box(0, 0);
			const text1 = new Text("Hello", 0, 0);
			const text2 = new Text("World", 0, 0);
			box.addChild(text1);
			// Removing text2 which was never added should not throw
			expect(() => box.removeChild(text2)).not.toThrow();
			expect(box.children.length).toBe(1);
		});
	});

	describe("clear", () => {
		test("removes all children", () => {
			const box = new Box(0, 0);
			box.addChild(new Text("First", 0, 0));
			box.addChild(new Text("Second", 0, 0));
			box.clear();
			expect(box.children.length).toBe(0);
			expect(box.render(40)).toEqual([]);
		});
	});

	describe("render", () => {
		test("applies horizontal padding to content", () => {
			const box = new Box(2, 0);
			box.addChild(new Text("Hi", 0, 0));
			const lines = box.render(40);
			// Content should be padded by 2 spaces on left
			expect(lines[0].startsWith("  ")).toBe(true);
		});

		test("pads lines to full width", () => {
			const box = new Box(1, 0);
			box.addChild(new Text("Hi", 0, 0));
			const lines = box.render(30);
			expect(visibleWidth(lines[0])).toBe(30);
		});

		test("caches rendered output", () => {
			const box = new Box(1, 0);
			box.addChild(new Text("Hello", 0, 0));
			const lines1 = box.render(40);
			const lines2 = box.render(40);
			// Should return same cached array
			expect(lines1).toBe(lines2);
		});

		test("re-renders when width changes", () => {
			const box = new Box(1, 0);
			box.addChild(new Text("Hello", 0, 0));
			const lines1 = box.render(40);
			const lines2 = box.render(30);
			// Different width should produce different result
			expect(lines1).not.toBe(lines2);
		});
	});

	describe("setBackgroundFn", () => {
		test("applies background function to lines", () => {
			const box = new Box(0, 0);
			box.addChild(new Text("Hello", 0, 0));
			box.setBackgroundFn((t) => `[BG]${t}[/BG]`);
			const lines = box.render(20);
			expect(lines[0].startsWith("[BG]")).toBe(true);
			expect(lines[0].endsWith("[/BG]")).toBe(true);
		});

		test("detects background function changes", () => {
			const box = new Box(0, 0);
			box.addChild(new Text("Hello", 0, 0));
			const lines1 = box.render(40);
			box.setBackgroundFn((t) => `[BG]${t}[/BG]`);
			const lines2 = box.render(40);
			// Background change should be detected via sampling
			expect(lines1).not.toEqual(lines2);
		});
	});

	describe("invalidate", () => {
		test("clears cache", () => {
			const box = new Box(1, 0);
			box.addChild(new Text("Hello", 0, 0));
			const lines1 = box.render(40);
			box.invalidate();
			const lines2 = box.render(40);
			// After invalidate, should be a new array
			expect(lines1).not.toBe(lines2);
		});

		test("invalidates children", () => {
			const box = new Box(0, 0);
			const text = new Text("Hello", 0, 0);
			box.addChild(text);
			// Render to cache
			box.render(40);
			text.render(40);
			// Invalidate box should also invalidate text
			let textInvalidated = false;
			const originalInvalidate = text.invalidate.bind(text);
			text.invalidate = () => {
				textInvalidated = true;
				originalInvalidate();
			};
			box.invalidate();
			expect(textInvalidated).toBe(true);
		});
	});
});
