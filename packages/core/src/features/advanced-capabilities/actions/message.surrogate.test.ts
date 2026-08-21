/** Surrogate safety for connector prefix and suffix splitting in message.ts. */
import { describe, expect, test } from "vitest";
import { splitConnectorPrefix, splitConnectorSuffix } from "./message.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return true;
}

describe("message action connector split surrogate safety", () => {
	test("prefix split with emoji in target remainder stays well-formed", () => {
		const fox = "🦊";
		const input = `discord:general-${fox}`;
		const res = splitConnectorPrefix(input);
		expect(res).not.toBeNull();
		if (res) {
			expect(isWellFormed(res.source)).toBe(true);
			expect(isWellFormed(res.target)).toBe(true);
			expect(res.source).toBe("discord");
			expect(res.target).toBe(`general-${fox}`);
		}
	});

	test("suffix split with emoji in target body stays well-formed", () => {
		const fox = "🦊";
		const input = `hello world ${fox} on discord`;
		const res = splitConnectorSuffix(input);
		expect(res).not.toBeNull();
		if (res) {
			expect(isWellFormed(res.source)).toBe(true);
			expect(isWellFormed(res.target)).toBe(true);
			expect(res.source).toBe("discord");
			expect(res.target).toBe(`hello world ${fox}`);
		}
	});

	test("lone high surrogate in connector prefix/suffix input is sanitized safely", () => {
		const badInput = "discord:bad \ud800 channel";
		const res = splitConnectorPrefix(badInput);
		if (res) {
			expect(isWellFormed(res.target)).toBe(true);
		}
	});

	test("sweep whitespace offsets with emojis stay well-formed", () => {
		const fox = "🦊";
		for (let spaces = 1; spaces <= 5; spaces++) {
			const input = `topic ${fox}${" ".repeat(spaces)}on slack`;
			const res = splitConnectorSuffix(input);
			expect(res).not.toBeNull();
			if (res) {
				expect(isWellFormed(res.target)).toBe(true);
				expect(() => JSON.stringify(res)).not.toThrow();
			}
		}
	});
});
