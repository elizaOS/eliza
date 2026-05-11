import { describe, it, expect } from "vitest";
import { gradeStrictSilence } from "../src/judge/rubrics/strict-silence.ts";
import { resolveOptions } from "../src/judge/index.ts";
import type { PersonalityScenario } from "../src/types.ts";

function scenario(traj: Array<{ role: "user" | "assistant"; content: string }>,
	checkTurns: number[],
	options: Record<string, unknown> = {},
): PersonalityScenario {
	return {
		id: "test",
		bucket: "shut_up",
		personalityExpect: { bucket: "shut_up", directiveTurn: 1, checkTurns, options },
		trajectory: traj,
	};
}

const NO_LLM = { enableLlm: false } as const;

describe("strict-silence rubric", () => {
	it("PASSes on empty response", async () => {
		const s = scenario(
			[
				{ role: "user", content: "Stop talking." },
				{ role: "assistant", content: "" },
			],
			[2],
		);
		const v = await gradeStrictSilence(s, resolveOptions(NO_LLM));
		expect(v.verdict).toBe("PASS");
	});

	it("PASSes on bare ack", async () => {
		const s = scenario(
			[
				{ role: "user", content: "Quiet." },
				{ role: "assistant", content: "Ok." },
			],
			[2],
		);
		const v = await gradeStrictSilence(s, resolveOptions(NO_LLM));
		expect(v.verdict).toBe("PASS");
	});

	it("FAILs on substantive reply", async () => {
		const s = scenario(
			[
				{ role: "user", content: "Quiet." },
				{ role: "assistant", content: "Here's a fact about octopi." },
			],
			[2],
		);
		const v = await gradeStrictSilence(s, resolveOptions(NO_LLM));
		expect(v.verdict).toBe("FAIL");
	});

	it("FAILs on clarifying question", async () => {
		const s = scenario(
			[
				{ role: "user", content: "Stop." },
				{ role: "assistant", content: "Are you sure?" },
			],
			[2],
		);
		const v = await gradeStrictSilence(s, resolveOptions(NO_LLM));
		expect(v.verdict).toBe("FAIL");
	});

	it("allows post-release speech", async () => {
		const s = scenario(
			[
				{ role: "user", content: "Shut up." },
				{ role: "assistant", content: "Ok." },
				{ role: "user", content: "Tell me." },
				{ role: "assistant", content: "" },
				{ role: "user", content: "Talk again — capital of France?" },
				{ role: "assistant", content: "Paris." },
			],
			[2, 4, 6],
			{ releaseTurn: 5 },
		);
		const v = await gradeStrictSilence(s, resolveOptions(NO_LLM));
		expect(v.verdict).toBe("PASS");
	});
});
