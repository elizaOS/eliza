import { describe, it, expect } from "vitest";
import { gradeStyleHeld } from "../src/judge/rubrics/style-held.ts";
import { resolveOptions } from "../src/judge/index.ts";
import type { PersonalityScenario } from "../src/types.ts";

function scenario(
	traj: Array<{ role: "user" | "assistant"; content: string }>,
	options: Record<string, unknown>,
	checkTurns: number[] = [2],
): PersonalityScenario {
	return {
		id: "test",
		bucket: "hold_style",
		personalityExpect: { bucket: "hold_style", directiveTurn: 1, checkTurns, options },
		trajectory: traj,
	};
}

const NO_LLM = { enableLlm: false } as const;

describe("style-held rubric", () => {
	it("terse PASS at limit", async () => {
		const s = scenario(
			[
				{ role: "user", content: "Be terse, 5 tokens max." },
				{ role: "assistant", content: "Sunny, seventy-two, light wind." },
			],
			{ style: "terse", maxTokens: 5 },
		);
		const v = await gradeStyleHeld(s, resolveOptions(NO_LLM));
		expect(v.verdict).toBe("PASS");
	});

	it("terse FAIL over limit", async () => {
		const s = scenario(
			[
				{ role: "user", content: "Terse, 5 max." },
				{ role: "assistant", content: "Today the weather is going to be sunny with a high of seventy-two degrees and a light breeze." },
			],
			{ style: "terse", maxTokens: 5 },
		);
		const v = await gradeStyleHeld(s, resolveOptions(NO_LLM));
		expect(v.verdict).toBe("FAIL");
	});

	it("haiku PASS", async () => {
		const s = scenario(
			[
				{ role: "user", content: "Haiku." },
				{
					role: "assistant",
					content: "Soft autumn breezes\nWhisper through the maple leaves\nQuiet falls again",
				},
			],
			{ style: "haiku" },
		);
		const v = await gradeStyleHeld(s, resolveOptions(NO_LLM));
		expect(v.verdict).toBe("PASS");
	});

	it("haiku FAIL single line", async () => {
		const s = scenario(
			[
				{ role: "user", content: "Haiku." },
				{ role: "assistant", content: "Just a single line, not a haiku." },
			],
			{ style: "haiku" },
		);
		const v = await gradeStyleHeld(s, resolveOptions(NO_LLM));
		expect(v.verdict).toBe("FAIL");
	});

	it("no-hedging FAIL with maybe", async () => {
		const s = scenario(
			[
				{ role: "user", content: "Don't hedge." },
				{ role: "assistant", content: "Maybe the deploy succeeded." },
			],
			{ style: "no-hedging" },
		);
		const v = await gradeStyleHeld(s, resolveOptions(NO_LLM));
		expect(v.verdict).toBe("FAIL");
	});

	it("no-emojis FAIL with emoji", async () => {
		const s = scenario(
			[
				{ role: "user", content: "No emojis." },
				{ role: "assistant", content: "Sure 👍" },
			],
			{ style: "no-emojis" },
		);
		const v = await gradeStyleHeld(s, resolveOptions(NO_LLM));
		expect(v.verdict).toBe("FAIL");
	});
});
