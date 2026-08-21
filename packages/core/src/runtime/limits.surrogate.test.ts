/**
 * Regression for limits surrogate-safe truncation (240).
 */

import { describe, expect, it } from "vitest";

import { toWellFormedUnicode, truncateWellFormed } from "../utils/well-formed";
import { getFailureSignature } from "./limits";

const LIMITS_TRUNCATE = 240;

function clampLimits(text: string): string {
	const wellFormed = toWellFormedUnicode(text ?? "");
	return truncateWellFormed(wellFormed, LIMITS_TRUNCATE);
}

function isWellFormed(s: string): boolean {
	const w = s as unknown as { isWellFormed?: () => boolean };
	if (typeof w.isWellFormed === "function") return w.isWellFormed();
	return toWellFormedUnicode(s) === s;
}

describe("limits well-formed", () => {
	it("backs off astral at 240 boundary (239+fox->239)", () => {
		const fox = "🦊";
		const input = `${"a".repeat(239)}${fox}${"b".repeat(20)}`;
		const out = clampLimits(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(239);
		expect(out).toBe("a".repeat(239));
	});

	it("preserves fitting astral at 240 (238+fox intact)", () => {
		const fox = "🦊";
		const input = `${"a".repeat(238)}${fox}`;
		const out = clampLimits(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe(input);
		expect(out.length).toBe(240);
	});

	it("sanitizes lone high surrogate", () => {
		const lone = `err ${String.fromCharCode(0xd800)} text`;
		const out = clampLimits(`${lone}${"x".repeat(300)}`);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("�")).toBe(true);
	});

	it("short passthrough", () => {
		expect(clampLimits("short error")).toBe("short error");
	});

	it("sweep around 240 well-formed", () => {
		const fox = "🦊";
		for (let n = 235; n <= 245; n++) {
			const input = `${"x".repeat(n)}${fox}${"y".repeat(20)}`;
			const out = clampLimits(input);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(240);
		}
	});
});

describe("getFailureSignature normalizes pre-existing lone surrogates", () => {
	// truncateWellFormed only guards the cut boundary. A lone surrogate that is
	// already sitting in the provider's error text — well short of 240 chars —
	// survives truncation untouched, so the normalization pass is what repairs
	// it. Dropping toWellFormedUnicode leaves the existing boundary tests green,
	// which is how that regression got through once already.
	it("repairs a lone surrogate far from the truncation boundary", () => {
		const signature = getFailureSignature({
			success: false,
			toolName: "WEB_FETCH",
			error: `upstream said \uD800 and stopped`,
		});

		expect(signature).not.toBeNull();
		expect(signature as string).toBe(toWellFormedUnicode(signature as string));
		expect((signature as string).includes("\uD800")).toBe(false);
	});
});
