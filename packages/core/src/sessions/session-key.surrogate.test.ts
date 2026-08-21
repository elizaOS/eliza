/**
 * Surrogate truncation for session-key normalization (1024 x2).
 */
import { describe, expect, it } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../utils/well-formed.js";
import { normalizeAccountId, normalizeAgentId } from "./session-key.ts";

describe("session-key surrogate handling", () => {
	it("1023+fox at 1024 backs off well-formed", () => {
		const s = `${"a".repeat(1023)}🦊${"b".repeat(10)}`;
		const safe = truncateWellFormed(toWellFormedUnicode(s), 1024);
		expect(safe.isWellFormed()).toBe(true);
		expect(safe.length).toBe(1023);
	});
	it("normalizeAgentId handles 1023+fox", () => {
		const s = `${"a".repeat(1023)}🦊${"b".repeat(10)}`;
		const out = normalizeAgentId(s);
		expect(out.isWellFormed()).toBe(true);
		expect(() => JSON.stringify(out)).not.toThrow();
	});
	it("normalizeAccountId handles 1023+fox", () => {
		const s = `${"a".repeat(1023)}🦊${"b".repeat(10)}`;
		const out = normalizeAccountId(s);
		expect(out.isWellFormed()).toBe(true);
		expect(() => JSON.stringify(out)).not.toThrow();
	});
	it("lone surrogates sanitized", () => {
		expect(normalizeAgentId("\ud800").isWellFormed()).toBe(true);
		expect(normalizeAccountId("\udc00").isWellFormed()).toBe(true);
	});
	it("sweep 0..30 at 1024", () => {
		for (let n = 0; n <= 30; n++) {
			const s = `${"a".repeat(n)}🦊${"b".repeat(2000)}`;
			const t = truncateWellFormed(toWellFormedUnicode(s), 1024);
			expect(t.isWellFormed()).toBe(true);
		}
	});
});
