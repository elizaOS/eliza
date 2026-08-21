/** Surrogate safety for settings-debug truncation: maskString and sanitizeDebugString must never emit lone surrogates. */
import { describe, expect, test } from "vitest";
import {
	MAX_STRING,
	sanitizeDebugString,
	sanitizeForSettingsDebug,
} from "./settings-debug.ts";
import { toWellFormedUnicode } from "./utils/well-formed.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return toWellFormedUnicode(value) === value;
}

describe("settings-debug surrogate handling", () => {
	test("maskString head surrogate boundary via sanitizeDebugString >48 with emoji at 4", () => {
		const input = `${"a".repeat(3)}🦊${"b".repeat(50)}`;
		const out = sanitizeDebugString(input);
		expect(isWellFormed(out)).toBe(true);
		expect(() => JSON.stringify(out)).not.toThrow();
		expect(out.includes("�")).toBe(false);
		expect(out.length).toBeLessThanOrEqual(MAX_STRING);
	});

	test("maskString tail surrogate boundary: ends with fox", () => {
		const input = `${"a".repeat(50)}🦊`;
		const out = sanitizeDebugString(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBeLessThanOrEqual(MAX_STRING);
		expect(() => JSON.stringify(out)).not.toThrow();
	});

	test("fitting short string with fox preserved without mask", () => {
		const input = `${"a".repeat(10)}🦊`;
		const out = sanitizeDebugString(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe(toWellFormedUnicode(input));
	});

	test("lone high surrogate sanitized to replacement", () => {
		const input = `ok \ud800 end ${"x".repeat(60)}`;
		const out = sanitizeDebugString(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("�")).toBe(true);
		expect(out.includes("\ud800")).toBe(false);
	});

	test("lone low surrogate sanitized to replacement", () => {
		const input = `ok \udc00 end ${"x".repeat(60)}`;
		const out = sanitizeDebugString(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("�")).toBe(true);
		expect(out.includes("\udc00")).toBe(false);
	});

	test("sweep 0..30 emoji offsets via mask path all well-formed", () => {
		const fox = "🦊";
		for (let n = 0; n <= 30; n++) {
			const input = `${"a".repeat(n)}${fox}${"b".repeat(60)}`;
			const out = sanitizeDebugString(input);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(MAX_STRING);
			expect(() => JSON.stringify(out)).not.toThrow();
		}
	});

	test("Bearer prefix with fox well-formed via mask", () => {
		const input = `Bearer ${"a".repeat(10)}🦊${"b".repeat(20)}`;
		const out = sanitizeDebugString(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBeLessThanOrEqual(MAX_STRING);
	});

	test("sanitizeForSettingsDebug wrapper stays well-formed for object with fox keys", () => {
		const payload = {
			key: `${"a".repeat(50)}🦊`,
			other: `${"b".repeat(50)}🦊`,
		};
		const out = sanitizeForSettingsDebug(payload) as Record<string, unknown>;
		const serialized = JSON.stringify(out);
		expect(() => JSON.parse(serialized)).not.toThrow();
		for (const v of Object.values(out)) {
			if (typeof v === "string") expect(isWellFormed(v)).toBe(true);
		}
	});

	test("MAX_STRING truncation path stays well-formed at 120", () => {
		const input = `${"a".repeat(119)}🦊`;
		const out = sanitizeDebugString(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBeLessThanOrEqual(MAX_STRING);
	});
});
