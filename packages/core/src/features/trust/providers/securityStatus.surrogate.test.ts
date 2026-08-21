/**
 * Surrogate truncation for securityStatus provider details (500).
 */
import { describe, expect, it } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../../../utils/well-formed.js";

describe("securityStatus surrogate handling", () => {
	it("truncates 499+fox at 500 well-formed", async () => {
		const fox = "🦊";
		const longDetails = "a".repeat(499) + fox + "b".repeat(10);
		const safe = truncateWellFormed(toWellFormedUnicode(longDetails), 500);
		expect(safe.isWellFormed()).toBe(true);
		expect(safe.length).toBe(499);
		expect(() => JSON.stringify(safe)).not.toThrow();
	});
	it("handles lone surrogates", async () => {
		expect(
			truncateWellFormed(toWellFormedUnicode("\ud800"), 500).isWellFormed(),
		).toBe(true);
		expect(
			truncateWellFormed(toWellFormedUnicode("\udc00"), 500).isWellFormed(),
		).toBe(true);
	});
	it("sweep 0..30 at 500 well-formed", async () => {
		for (let n = 0; n <= 30; n++) {
			const s = `${"a".repeat(n)}🦊${"b".repeat(600)}`;
			const t = truncateWellFormed(toWellFormedUnicode(s), 500);
			expect(t.isWellFormed()).toBe(true);
			expect(t.length).toBeLessThanOrEqual(500);
			expect(() => JSON.stringify(t)).not.toThrow();
		}
	});
	it("fitting 498+fox at 500", () => {
		const s = `${"a".repeat(498)}🦊`;
		const safe = truncateWellFormed(toWellFormedUnicode(s), 500);
		expect(safe.length).toBe(500);
		expect(safe.isWellFormed()).toBe(true);
	});
});
