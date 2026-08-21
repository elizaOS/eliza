/**
 * Regression for model-gateway-lease surrogate-safe truncation (200).
 */

import { describe, expect, it } from "vitest";
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";

const LEASE_DETAIL_LIMIT = 200;

function clampLeaseDetail(detail: string): string {
	const wellFormed = toWellFormedUnicode(detail);
	return truncateWellFormed(wellFormed, LEASE_DETAIL_LIMIT);
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

describe("model-gateway-lease well-formed", () => {
	it("backs off astral at 200 boundary (199+fox->199)", () => {
		const fox = "🦊";
		const input = `${"a".repeat(199)}${fox}${"b".repeat(20)}`;
		const out = clampLeaseDetail(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(199);
		expect(out).toBe("a".repeat(199));
	});

	it("preserves fitting astral at 200 (198+fox intact)", () => {
		const fox = "🦊";
		const input = `${"a".repeat(198)}${fox}`;
		const out = clampLeaseDetail(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe(input);
		expect(out.length).toBe(200);
	});

	it("sanitizes lone high surrogate", () => {
		const lone = `lease ${String.fromCharCode(0xd800)} detail`;
		const out = clampLeaseDetail(`${lone}${"x".repeat(300)}`);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("�")).toBe(true);
	});

	it("short passthrough", () => {
		expect(clampLeaseDetail("short lease detail")).toBe("short lease detail");
	});

	it("sweep around 200 well-formed", () => {
		const fox = "🦊";
		for (let n = 195; n <= 205; n++) {
			const input = `${"x".repeat(n)}${fox}${"y".repeat(20)}`;
			const out = clampLeaseDetail(input);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(200);
		}
	});
});
