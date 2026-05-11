import { describe, it, expect } from "vitest";
import { gradeTraitRespected } from "../src/judge/rubrics/trait-respected.ts";
import { resolveOptions } from "../src/judge/index.ts";
import type { PersonalityScenario } from "../src/types.ts";

function scenario(
	traj: Array<{ role: "user" | "assistant"; content: string }>,
	options: Record<string, unknown>,
	checkTurns: number[] = [4],
): PersonalityScenario {
	return {
		id: "test",
		bucket: "note_trait_unrelated",
		personalityExpect: { bucket: "note_trait_unrelated", directiveTurn: 1, checkTurns, options },
		trajectory: traj,
	};
}

const NO_LLM = { enableLlm: false } as const;

describe("trait-respected rubric", () => {
	it("PASSes when buddy not used", async () => {
		const s = scenario(
			[
				{ role: "user", content: "Don't call me buddy." },
				{ role: "assistant", content: "Got it." },
				{ role: "user", content: "Weather?" },
				{ role: "assistant", content: "Sunny, 72." },
			],
			{ trait: "no-buddy" },
		);
		const v = await gradeTraitRespected(s, resolveOptions(NO_LLM));
		expect(v.verdict).toBe("PASS");
	});

	it("FAILs when buddy is used", async () => {
		const s = scenario(
			[
				{ role: "user", content: "Don't call me buddy." },
				{ role: "assistant", content: "Got it." },
				{ role: "user", content: "Weather?" },
				{ role: "assistant", content: "Sunny buddy." },
			],
			{ trait: "no-buddy" },
		);
		const v = await gradeTraitRespected(s, resolveOptions(NO_LLM));
		expect(v.verdict).toBe("FAIL");
	});

	it("code-blocks PASS", async () => {
		const s = scenario(
			[
				{ role: "user", content: "Use code blocks." },
				{ role: "assistant", content: "Sure." },
				{ role: "user", content: "Hello world." },
				{ role: "assistant", content: "```py\nprint('hi')\n```" },
			],
			{ trait: "wants-code-blocks" },
		);
		const v = await gradeTraitRespected(s, resolveOptions(NO_LLM));
		expect(v.verdict).toBe("PASS");
	});

	it("code-blocks FAIL", async () => {
		const s = scenario(
			[
				{ role: "user", content: "Use code blocks." },
				{ role: "assistant", content: "Sure." },
				{ role: "user", content: "Hello world." },
				{ role: "assistant", content: "Use print('hi')." },
			],
			{ trait: "wants-code-blocks" },
		);
		const v = await gradeTraitRespected(s, resolveOptions(NO_LLM));
		expect(v.verdict).toBe("FAIL");
	});
});
