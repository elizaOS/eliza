import { describe, expect, test } from "vitest";
import { Text } from "../src/components/text.js";
import { visibleWidth } from "../src/utils.js";

describe("Text component", () => {
	describe("constructor", () => {
		test("creates empty Text with default padding", () => {
			const text = new Text();
			const lines = text.render(40);
			// Empty text returns empty array
			expect(lines).toEqual([]);
		});

		test("creates Text with content", () => {
			const text = new Text("Hello, World!");
			const lines = text.render(40);
			// Should have vertical padding (1 empty line top + 1 content + 1 empty line bottom)
			expect(lines.length).toBe(3);
		});

		test("creates Text with custom padding", () => {
			const text = new Text("Hello", 2, 2);
			const lines = text.render(40);
			// 2 empty top + 1 content + 2 empty bottom = 5
			expect(lines.length).toBe(5);
		});
	});

	describe("render", () => {
		test("renders text with horizontal padding", () => {
			const text = new Text("Hello", 2, 0);
			const lines = text.render(20);
			expect(lines.length).toBe(1);
			// Check padding on left side
			expect(lines[0].startsWith("  Hello")).toBe(true);
		});

		test("wraps long text", () => {
			const text = new Text("This is a long text that should wrap", 0, 0);
			const lines = text.render(20);
			// Should wrap to multiple lines
			expect(lines.length).toBeGreaterThan(1);
		});

		test("handles tabs by converting to spaces", () => {
			const text = new Text("Hello\tWorld", 0, 0);
			const lines = text.render(80);
			// Tab should be converted to 3 spaces
			expect(lines[0]).toContain("   ");
		});

		test("pads lines to full width", () => {
			const text = new Text("Hi", 1, 0);
			const lines = text.render(20);
			expect(visibleWidth(lines[0])).toBe(20);
		});

		test("returns empty array for whitespace-only text", () => {
			const text = new Text("   ");
			const lines = text.render(40);
			expect(lines).toEqual([]);
		});

		test("caches rendered output", () => {
			const text = new Text("Hello");
			const lines1 = text.render(40);
			const lines2 = text.render(40);
			// Should return same cached array
			expect(lines1).toBe(lines2);
		});

		test("re-renders when width changes", () => {
			const text = new Text("Hello");
			const lines1 = text.render(40);
			const lines2 = text.render(30);
			// Different width should produce different result
			expect(lines1).not.toBe(lines2);
		});
	});

	describe("setText", () => {
		test("updates text content", () => {
			const text = new Text("Hello");
			text.setText("Goodbye");
			const lines = text.render(40);
			expect(lines.some((l) => l.includes("Goodbye"))).toBe(true);
		});

		test("invalidates cache", () => {
			const text = new Text("Hello");
			const lines1 = text.render(40);
			text.setText("World");
			const lines2 = text.render(40);
			expect(lines1).not.toBe(lines2);
		});
	});

	describe("setCustomBgFn", () => {
		test("applies background function to lines", () => {
			const text = new Text("Hello", 0, 0);
			// Simple mock function that wraps text
			text.setCustomBgFn((t) => `[BG]${t}[/BG]`);
			const lines = text.render(20);
			expect(lines[0].startsWith("[BG]")).toBe(true);
			expect(lines[0].endsWith("[/BG]")).toBe(true);
		});

		test("invalidates cache when background changes", () => {
			const text = new Text("Hello", 0, 0);
			const lines1 = text.render(40);
			text.setCustomBgFn((t) => `[BG]${t}[/BG]`);
			const lines2 = text.render(40);
			expect(lines1).not.toBe(lines2);
		});
	});

	describe("invalidate", () => {
		test("clears cache", () => {
			const text = new Text("Hello");
			const lines1 = text.render(40);
			text.invalidate();
			const lines2 = text.render(40);
			// After invalidate, should be a new array (not same reference)
			expect(lines1).not.toBe(lines2);
		});
	});
});
