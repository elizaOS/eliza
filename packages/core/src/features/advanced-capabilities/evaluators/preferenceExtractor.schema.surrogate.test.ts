/** Surrogate safety for AddDirectiveOpSchema text transform: must never emit lone surrogates. */
import { describe, expect, test } from "vitest";
import { toWellFormedUnicode } from "../../../utils/well-formed.ts";
import { MAX_DIRECTIVE_CHARS } from "../personality/types.ts";
import { parsePreferenceOutputTolerant } from "./preferenceExtractor.schema.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return toWellFormedUnicode(value) === value;
}

describe("AddDirectiveOpSchema surrogate safety", () => {
	test("emoji at 199 boundary backs off to 199 without lone surrogate at 200 cap", () => {
		const payload = {
			ops: [
				{
					op: "add_directive",
					text: `${"a".repeat(199)}🦊${"b".repeat(50)}`,
					confidence: 0.9,
				},
			],
		};
		const res = parsePreferenceOutputTolerant(payload);
		expect(res).not.toBeNull();
		const op = res?.ops[0];
		expect(op?.op).toBe("add_directive");
		if (op?.op === "add_directive") {
			expect(isWellFormed(op.text)).toBe(true);
			expect(op.text.length).toBe(199);
			expect(op.text.endsWith("🦊")).toBe(false);
			expect(() => JSON.stringify({ text: op.text })).not.toThrow();
		}
	});

	test("fitting emoji ending at 200 kept intact", () => {
		const payload = {
			ops: [
				{
					op: "add_directive",
					text: `${"a".repeat(198)}🦊`,
					confidence: 0.9,
				},
			],
		};
		const res = parsePreferenceOutputTolerant(payload);
		expect(res).not.toBeNull();
		const op = res?.ops[0];
		if (op?.op === "add_directive") {
			expect(isWellFormed(op.text)).toBe(true);
			expect(op.text.length).toBe(200);
			expect(op.text.endsWith("🦊")).toBe(true);
		}
	});

	test("short directive with emoji passes through untouched", () => {
		const payload = {
			ops: [
				{
					op: "add_directive",
					text: "Always respond with a fox emoji 🦊",
					confidence: 1.0,
				},
			],
		};
		const res = parsePreferenceOutputTolerant(payload);
		expect(res).not.toBeNull();
		const op = res?.ops[0];
		if (op?.op === "add_directive") {
			expect(isWellFormed(op.text)).toBe(true);
			expect(op.text).toBe("Always respond with a fox emoji 🦊");
		}
	});

	test("lone high surrogate is sanitized before truncation", () => {
		const payload = {
			ops: [
				{
					op: "add_directive",
					text: `bad \ud800 surrogate ${"x".repeat(300)}`,
					confidence: 0.8,
				},
			],
		};
		const res = parsePreferenceOutputTolerant(payload);
		expect(res).not.toBeNull();
		const op = res?.ops[0];
		if (op?.op === "add_directive") {
			expect(isWellFormed(op.text)).toBe(true);
			expect(op.text.includes("\ud800")).toBe(false);
			expect(op.text.length).toBeLessThanOrEqual(MAX_DIRECTIVE_CHARS);
		}
	});

	test("sweep 195..205 emoji offsets at 200 cap all stay well-formed", () => {
		const fox = "🦊";
		for (let n = 195; n <= 205; n++) {
			const payload = {
				ops: [
					{
						op: "add_directive",
						text: `${"a".repeat(n)}${fox}${"b".repeat(50)}`,
						confidence: 0.9,
					},
				],
			};
			const res = parsePreferenceOutputTolerant(payload);
			expect(res).not.toBeNull();
			const op = res?.ops[0];
			if (op?.op === "add_directive") {
				expect(isWellFormed(op.text)).toBe(true);
				expect(op.text.length).toBeLessThanOrEqual(MAX_DIRECTIVE_CHARS);
			}
		}
	});
});
