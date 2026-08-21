/**
 * Surrogate truncation for role normalizeEntityLookupName (1024).
 */
import { describe, expect, it } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../../../utils/well-formed.js";

describe("role normalize surrogate handling", () => {
	it("1023+fox at 1024 backs off", () => {
		const s = `${"a".repeat(1023)}🦊${"b".repeat(10)}`;
		const safe = truncateWellFormed(toWellFormedUnicode(s), 1024);
		expect(safe.isWellFormed()).toBe(true);
		expect(safe.length).toBe(1023);
	});
	it("1022+fox fits", () => {
		const s = `${"a".repeat(1022)}🦊`;
		const safe = truncateWellFormed(toWellFormedUnicode(s), 1024);
		expect(safe.length).toBe(1024);
	});
	it("lone surrogates sanitized", () => {
		expect(
			truncateWellFormed(toWellFormedUnicode("\ud800"), 1024).isWellFormed(),
		).toBe(true);
		expect(
			truncateWellFormed(toWellFormedUnicode("\udc00"), 1024).isWellFormed(),
		).toBe(true);
	});
	it("sweep 0..30 at 1024", () => {
		for (let n = 0; n <= 30; n++) {
			const s = `${"a".repeat(n)}🦊${"b".repeat(2000)}`;
			const t = truncateWellFormed(toWellFormedUnicode(s), 1024);
			expect(t.isWellFormed()).toBe(true);
			expect(() => JSON.stringify(t)).not.toThrow();
		}
	});
});
