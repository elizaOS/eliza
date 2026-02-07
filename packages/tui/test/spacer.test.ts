import { describe, expect, test } from "vitest";
import { Spacer } from "../src/components/spacer.js";

describe("Spacer component", () => {
	describe("constructor", () => {
		test("creates Spacer with default 1 line", () => {
			const spacer = new Spacer();
			const lines = spacer.render(40);
			expect(lines.length).toBe(1);
			expect(lines[0]).toBe("");
		});

		test("creates Spacer with custom line count", () => {
			const spacer = new Spacer(3);
			const lines = spacer.render(40);
			expect(lines.length).toBe(3);
			expect(lines.every((l) => l === "")).toBe(true);
		});

		test("creates Spacer with zero lines", () => {
			const spacer = new Spacer(0);
			const lines = spacer.render(40);
			expect(lines.length).toBe(0);
		});
	});

	describe("setLines", () => {
		test("updates line count", () => {
			const spacer = new Spacer(1);
			spacer.setLines(5);
			const lines = spacer.render(40);
			expect(lines.length).toBe(5);
		});
	});

	describe("render", () => {
		test("returns empty strings regardless of width", () => {
			const spacer = new Spacer(2);
			const lines = spacer.render(100);
			expect(lines[0]).toBe("");
			expect(lines[1]).toBe("");
		});

		test("ignores width parameter", () => {
			const spacer = new Spacer(1);
			const lines1 = spacer.render(10);
			const lines2 = spacer.render(100);
			expect(lines1).toEqual(lines2);
		});
	});

	describe("invalidate", () => {
		test("does not throw", () => {
			const spacer = new Spacer();
			expect(() => spacer.invalidate()).not.toThrow();
		});
	});
});
