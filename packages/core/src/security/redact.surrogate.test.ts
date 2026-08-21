/** Surrogate safety for security token masking and text redaction. */
import { describe, expect, test } from "vitest";
import { redactSensitiveText } from "./redact.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return true;
}

describe("security redact surrogate safety", () => {
	test("emoji in token head backs off without lone surrogate", () => {
		const fox = "🦊";
		const token = "abc" + fox + "long_secret_key_123456789";
		const text = `API_KEY=${token}`;
		const redacted = redactSensitiveText(text);
		expect(isWellFormed(redacted)).toBe(true);
		expect(redacted.includes("…")).toBe(true);
		expect(() => JSON.stringify({ redacted })).not.toThrow();
	});

	test("emoji in token tail backs off without lone surrogate", () => {
		const fox = "🦊";
		const token = "long_prefix_secret_token_123" + fox + "xyz";
		const text = `API_KEY=${token}`;
		const redacted = redactSensitiveText(text);
		expect(isWellFormed(redacted)).toBe(true);
		expect(redacted.includes("…")).toBe(true);
		expect(() => JSON.stringify({ redacted })).not.toThrow();
	});

	test("short token returns asterisks safely", () => {
		const text = "API_KEY=short_sec_12";
		const redacted = redactSensitiveText(text);
		expect(isWellFormed(redacted)).toBe(true);
		expect(redacted).toContain("***");
	});

	test("lone high surrogate in text does not throw during redaction", () => {
		const badInput = '{"apiKey": "bad \ud800 long_secret_val_123456"}';
		expect(() => redactSensitiveText(badInput)).not.toThrow();
	});

	test("sweep offsets for credential tokens all stay well-formed", () => {
		const fox = "🦊";
		for (let n = 3; n <= 10; n++) {
			const token = "a".repeat(n) + fox + "b".repeat(20);
			const text = `API_KEY=${token}`;
			const redacted = redactSensitiveText(text);
			expect(isWellFormed(redacted)).toBe(true);
			expect(() => JSON.stringify({ redacted })).not.toThrow();
		}
	});
});
