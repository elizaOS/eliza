/** AddDirectiveOpSchema preserves complete directives while repairing invalid Unicode. */
import { describe, expect, test } from "vitest";
import { toWellFormedUnicode } from "../../../utils/well-formed.ts";
import { parsePreferenceOutputTolerant } from "./preferenceExtractor.schema.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return toWellFormedUnicode(value) === value;
}

describe("AddDirectiveOpSchema surrogate safety", () => {
	test("preserves a directive beyond the former 200-character boundary", () => {
		const input = `${"a".repeat(199)}🦊${"b".repeat(50)}`;
		const payload = {
			ops: [
				{
					op: "add_directive",
					text: input,
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
			expect(op.text).toBe(input);
			expect(() => JSON.stringify({ text: op.text })).not.toThrow();
		}
	});

	test("emoji ending at the former boundary is kept intact", () => {
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

	test("lone high surrogate is sanitized without shortening the directive", () => {
		const input = `bad \ud800 surrogate ${"x".repeat(300)}`;
		const payload = {
			ops: [
				{
					op: "add_directive",
					text: input,
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
			expect(op.text.length).toBe(input.length);
			expect(op.text.endsWith("x".repeat(300))).toBe(true);
		}
	});

	test("sweep across the former boundary preserves every complete directive", () => {
		const fox = "🦊";
		for (let n = 195; n <= 205; n++) {
			const input = `${"a".repeat(n)}${fox}${"b".repeat(50)}`;
			const payload = {
				ops: [
					{
						op: "add_directive",
						text: input,
						confidence: 0.9,
					},
				],
			};
			const res = parsePreferenceOutputTolerant(payload);
			expect(res).not.toBeNull();
			const op = res?.ops[0];
			if (op?.op === "add_directive") {
				expect(isWellFormed(op.text)).toBe(true);
				expect(op.text).toBe(input);
			}
		}
	});
});
