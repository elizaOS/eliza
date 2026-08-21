/**
 * Regression for page-scoped-context surrogate-safe truncation (280).
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const PAGE_CONTEXT_LIMIT = 280;

function clampPageContext(text: string): string {
	const wellFormed = toWellFormedUnicode(text ?? "");
	return truncateWellFormed(wellFormed, PAGE_CONTEXT_LIMIT);
}

function isWellFormed(s: string): boolean {
	const w = s as unknown as { isWellFormed?: () => boolean };
	if (typeof w.isWellFormed === "function") return w.isWellFormed();
	return toWellFormedUnicode(s) === s;
}

describe("page-scoped-context well-formed", () => {
	it("backs off astral at 280 boundary (279+fox->279)", () => {
		const fox = "🦊";
		const input = `${"a".repeat(279)}${fox}${"b".repeat(20)}`;
		const out = clampPageContext(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(279);
		expect(out).toBe("a".repeat(279));
	});

	it("preserves fitting astral at 280 (278+fox intact)", () => {
		const fox = "🦊";
		const input = `${"a".repeat(278)}${fox}`;
		const out = clampPageContext(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe(input);
		expect(out.length).toBe(280);
	});

	it("sanitizes lone high surrogate", () => {
		const lone = `ctx ${String.fromCharCode(0xd800)} text`;
		const out = clampPageContext(`${lone}${"x".repeat(400)}`);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("�")).toBe(true);
	});

	it("short passthrough", () => {
		expect(clampPageContext("short context")).toBe("short context");
	});

	it("sweep around 280 well-formed", () => {
		const fox = "🦊";
		for (let n = 275; n <= 285; n++) {
			const input = `${"x".repeat(n)}${fox}${"y".repeat(20)}`;
			const out = clampPageContext(input);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(280);
		}
	});
});
