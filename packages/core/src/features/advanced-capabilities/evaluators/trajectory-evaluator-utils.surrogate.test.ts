/**
 * Regression for trajectory evaluator utils surrogate-safe truncation (600).
 */

import { describe, expect, it } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../../../utils/well-formed.ts";

const TRAJECTORY_LIMIT = 600;

function clampTrajectory(text: string): string {
	const wellFormed = toWellFormedUnicode(text);
	return truncateWellFormed(wellFormed, TRAJECTORY_LIMIT);
}

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			i++;
		} else if (code >= 0xdc00 && code <= 0xdfff) return false;
	}
	return true;
}

describe("trajectory evaluator utils well-formed", () => {
	it("backs off astral at 600 boundary (599+fox->599)", () => {
		const fox = "🦊";
		const input = `${"a".repeat(599)}${fox}${"b".repeat(20)}`;
		const out = clampTrajectory(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(599);
		expect(out).toBe("a".repeat(599));
	});

	it("preserves fitting astral at 600 (598+fox intact)", () => {
		const fox = "🦊";
		const input = `${"a".repeat(598)}${fox}`;
		const out = clampTrajectory(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe(input);
		expect(out.length).toBe(600);
	});

	it("sanitizes lone high surrogate", () => {
		const lone = `prompt ${String.fromCharCode(0xd800)} text`;
		const out = clampTrajectory(`${lone}${"x".repeat(700)}`);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("�")).toBe(true);
	});

	it("short passthrough", () => {
		expect(clampTrajectory("short prompt")).toBe("short prompt");
	});

	it("sweep around 600 well-formed", () => {
		const fox = "🦊";
		for (let n = 595; n <= 605; n++) {
			const input = `${"x".repeat(n)}${fox}${"y".repeat(20)}`;
			const out = clampTrajectory(input);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(600);
		}
	});
});
