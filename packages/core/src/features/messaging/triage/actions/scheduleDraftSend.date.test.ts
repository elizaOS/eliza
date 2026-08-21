/** Date ISO serialization safety for scheduleDraftSend.ts. */
import { describe, expect, test } from "vitest";
import { formatSendAtIso } from "./scheduleDraftSend.ts";

describe("scheduleDraftSend date safety", () => {
	test("valid timestamp formats to valid ISO-8601 string", () => {
		const ts = 1700000000000;
		const iso = formatSendAtIso(ts);
		expect(iso).toBe("2023-11-14T22:13:20.000Z");
	});

	test("NaN timestamp returns string without throw", () => {
		expect(() => formatSendAtIso(Number.NaN)).not.toThrow();
		expect(formatSendAtIso(Number.NaN)).toBe("NaN");
	});

	test("Infinity timestamp returns string without throw", () => {
		expect(() => formatSendAtIso(Number.POSITIVE_INFINITY)).not.toThrow();
		expect(formatSendAtIso(Number.POSITIVE_INFINITY)).toBe("Infinity");
	});

	test("out-of-range epoch milliseconds returns fallback without throw", () => {
		const outOfRange = 8640000000000001; // Exceeds ECMAScript max Date range
		expect(() => formatSendAtIso(outOfRange)).not.toThrow();
		expect(formatSendAtIso(outOfRange)).toBe("8640000000000001");
	});
});
