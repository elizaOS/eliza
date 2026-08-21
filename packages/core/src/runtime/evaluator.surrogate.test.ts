/**
 * Surrogate truncation for evaluator shape error (200).
 */
import { describe, expect, it } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../utils/well-formed.js";

describe("evaluator surrogate handling", () => {
	it("truncates 199+fox at 200 well-formed", () => {
		const s = `${"a".repeat(199)}🦊${"b".repeat(10)}`;
		const safe = truncateWellFormed(
			toWellFormedUnicode(JSON.stringify({ x: s })),
			200,
		);
		expect(safe.isWellFormed()).toBe(true);
		expect(safe.length).toBeLessThanOrEqual(200);
		expect(() => JSON.stringify(safe)).not.toThrow();
	});
	it("200 boundary: 198+fox fits, 199+fox backs off", () => {
		const { truncateWellFormed: tw, toWellFormedUnicode: twf } = {
			truncateWellFormed,
			toWellFormedUnicode,
		};
		const a = `${"a".repeat(198)}🦊`;
		expect(tw(twf(a), 200).length).toBe(200);
		const b = `${"a".repeat(199)}🦊`;
		expect(tw(twf(b), 200).length).toBe(199);
	});
	it("lone surrogates sanitized", () => {
		expect(
			truncateWellFormed(toWellFormedUnicode("\ud800"), 200).isWellFormed(),
		).toBe(true);
		expect(
			truncateWellFormed(toWellFormedUnicode("\udc00"), 200).isWellFormed(),
		).toBe(true);
	});
	it("sweep 0..30 at 200 well-formed", () => {
		for (let n = 0; n <= 30; n++) {
			const s = `${"a".repeat(n)}🦊${"b".repeat(300)}`;
			const t = truncateWellFormed(toWellFormedUnicode(s), 200);
			expect(t.isWellFormed()).toBe(true);
			expect(() => JSON.stringify(t)).not.toThrow();
		}
	});
});
