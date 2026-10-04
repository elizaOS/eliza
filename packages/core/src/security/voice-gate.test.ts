import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../types/runtime.js";
import { buildVoiceGatePrompt } from "./voice-gate.js";

describe("voice-gate source", () => {
	it("contains no literal NUL bytes, so git and rg treat it as text", () => {
		const bytes = readFileSync(new URL("./voice-gate.ts", import.meta.url));
		expect(bytes.includes(0)).toBe(false);
	});
});

describe("buildVoiceGatePrompt persona completeness", () => {
	const character = {
		name: "Iris",
		bio: [
			"Keeper of the lighthouse ledger.",
			"Grew up between two harbors.",
			"Answers questions with concrete examples.",
			"Prefers short sentences.",
			"Fifth bio line that a four-line cap would drop.",
			"Sixth bio line that a four-line cap would drop.",
		],
		style: {
			all: [
				"Never use exclamation marks.",
				"Answer in English.",
				"Be direct.",
				"Fourth style directive that a six-line cap would drop.",
				"Fifth style directive that a six-line cap would drop.",
			],
			chat: [
				"Sign messages with the harbor sign-off.",
				"Second chat directive beyond the cap.",
				"Third chat directive beyond the cap.",
			],
		},
	} as unknown as IAgentRuntime["character"];

	it("includes every bio line, including those beyond the removed four-line cap", () => {
		const prompt = buildVoiceGatePrompt(character, "hello");
		for (const line of character.bio) {
			expect(prompt).toContain(line);
		}
	});

	it("includes every style directive, including those beyond the removed six-line cap", () => {
		const prompt = buildVoiceGatePrompt(character, "hello");
		for (const line of [...character.style.all, ...character.style.chat]) {
			expect(prompt).toContain(line);
		}
	});

	it("keeps the raw message text verbatim in the prompt", () => {
		const raw = "Balance: 12.50 USD due 2026-06-01, path /srv/a[1].txt";
		const prompt = buildVoiceGatePrompt(character, raw);
		expect(prompt).toContain(raw);
	});

	it("filters blank and non-string persona entries instead of emitting empty bullets", () => {
		const noisy = {
			name: "Iris",
			bio: ["", "   ", "Only real fact.", 42, null],
			style: { all: ["", "Real directive."], chat: [undefined, ""] },
		} as unknown as IAgentRuntime["character"];
		const prompt = buildVoiceGatePrompt(noisy, "hello");
		expect(prompt).toContain("Only real fact.");
		expect(prompt).toContain("Real directive.");
		for (const line of prompt.split("\n")) {
			expect(line.trim()).not.toBe("-");
		}
	});

	it("falls back to a generic name when the character has none", () => {
		const prompt = buildVoiceGatePrompt(undefined, "hello");
		expect(prompt).toContain("You are the assistant.");
	});
});
