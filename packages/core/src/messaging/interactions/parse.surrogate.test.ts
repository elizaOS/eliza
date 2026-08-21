/** Surrogate safety for interaction option kind parsing and unclaimed markup stripping. */
import { describe, expect, test } from "vitest";
import { stripUnclaimedInteractionMarkup } from "./parse.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return true;
}

describe("interactions parse surrogate safety", () => {
	test("emoji in unclaimed option prefix evaluated safely without lone surrogate", () => {
		const fox = "🦊";
		const input = `Here is some content\n[CHOICE:test]\n${fox}reply:payload=Label\n`;
		const stripped = stripUnclaimedInteractionMarkup(input);
		expect(isWellFormed(stripped)).toBe(true);
		expect(() => JSON.stringify({ stripped })).not.toThrow();
	});

	test("unclaimed followups block with emojis stripped cleanly", () => {
		const fox = "🦊";
		const input = `Message content ${fox}\n\n[FOLLOWUPS]\nreply:foo=Option 1\n`;
		const stripped = stripUnclaimedInteractionMarkup(input);
		expect(isWellFormed(stripped)).toBe(true);
		expect(stripped).toBe(`Message content ${fox}`);
	});

	test("lone high surrogate in line sanitized safely", () => {
		const badInput = "Message \ud800\n[CHOICE:test]\nreply:opt=Label\n";
		const stripped = stripUnclaimedInteractionMarkup(badInput);
		expect(isWellFormed(stripped)).toBe(true);
	});

	test("sweep offsets for option lines with emojis stay well-formed", () => {
		const fox = "🦊";
		for (let spaces = 0; spaces < 5; spaces++) {
			const input = `Prefix ${" ".repeat(spaces)}${fox}\n[CHOICE:test]\nreply:foo=Bar\n`;
			const stripped = stripUnclaimedInteractionMarkup(input);
			expect(isWellFormed(stripped)).toBe(true);
			expect(() => JSON.stringify({ stripped })).not.toThrow();
		}
	});
});
