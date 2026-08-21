/**
 * Regression for direct-action-heuristics unwrapPlannerIdentifier surrogate safety.
 */

import { describe, expect, it } from "vitest";
import { unwrapPlannerIdentifier } from "./direct-action-heuristics.ts";

function isWellFormed(v: string): boolean {
	if (!v) return true;
	if (
		typeof (v as unknown as { isWellFormed?: () => boolean }).isWellFormed ===
		"function"
	)
		return (v as unknown as { isWellFormed: () => boolean }).isWellFormed();
	for (let i = 0; i < v.length; i++) {
		const c = v.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			const n = v.charCodeAt(i + 1);
			if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
			i++;
		} else if (c >= 0xdc00 && c <= 0xdfff) return false;
	}
	return true;
}

describe("direct-action-heuristics unwrapPlannerIdentifier surrogate safety", () => {
	it("keeps surrogate pair intact at 10,000-char boundary", () => {
		const fox = String.fromCharCode(0xd83e, 0xdd8a);
		const input = `${"a".repeat(9999)}${fox}${"b".repeat(50)}`;
		const out = unwrapPlannerIdentifier(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(9999);
		expect(out).not.toContain("\uD83E");
	});

	it("unwraps XML tag identifiers correctly", () => {
		expect(unwrapPlannerIdentifier("<SEND_MESSAGE>")).toBe("SEND_MESSAGE");
		expect(unwrapPlannerIdentifier('"SEND_MESSAGE"')).toBe("SEND_MESSAGE");
	});

	it("sanitizes lone surrogate in raw planner token", () => {
		const lone = `planner ${String.fromCharCode(0xd800)} action ${"a".repeat(20000)}`;
		const out = unwrapPlannerIdentifier(lone);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("\uFFFD")).toBe(true);
		expect(out.length).toBeLessThanOrEqual(10_000);
	});
});
