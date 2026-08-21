import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function trunc(text: string, cap: number) {
	return truncateWellFormed(toWellFormedUnicode(text), cap);
}
const isWellFormed = (s: string) => {
	const w = s as unknown as { isWellFormed?: () => boolean };
	if (typeof w.isWellFormed === "function") return w.isWellFormed();
	return toWellFormedUnicode(s) === s;
};

describe("catalog-commands surrogate safety (Discord 1900/100 strict)", () => {
	const R = "🦊";
	it("1900 cap backs off mid-pair", () => {
		const input = `${"a".repeat(1899)}${R}b`;
		const out = trunc(input, 1900);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(1899);
		expect(out.endsWith("\ud83d")).toBe(false);
	});
	it("1900 cap preserves fitting emoji", () => {
		const input = `${"a".repeat(1898)}${R}`;
		expect(trunc(input, 1900)).toBe(`${"a".repeat(1898)}${R}`);
	});
	it("100 cap backs off mid-pair for choice name", () => {
		const input = `${"a".repeat(99)}${R}b`;
		const out = trunc(input, 100);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(99);
	});
	it("sweep 0..65 at 1900 stays well-formed", () => {
		for (let off = 0; off <= 65; off++) {
			const input = `${"a".repeat(off)}${R}${"b".repeat(2000)}`;
			expect(isWellFormed(trunc(input, 1900))).toBe(true);
		}
	});
	it("lone surrogate sanitised", () => {
		const out = trunc(`ok \ud83d end ${"x".repeat(2000)}`, 1900);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("\ud83d")).toBe(false);
		expect(out.includes("�")).toBe(true);
	});
	it("empty reply handled", () => {
		expect(trunc("", 1900)).toBe("");
		expect(isWellFormed(trunc("", 1900))).toBe(true);
	});
});
