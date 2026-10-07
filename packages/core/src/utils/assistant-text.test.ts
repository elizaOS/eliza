import { describe, expect, it } from "vitest";
import { stripAssistantStageDirections } from "./assistant-text.ts";

describe("stripAssistantStageDirections", () => {
	it("removes a bare roleplay action and keeps the reply", () => {
		expect(stripAssistantStageDirections("*smiles* Hello")).toBe("Hello");
		expect(stripAssistantStageDirections("*smiles warmly* Hello")).toBe(
			"Hello",
		);
	});

	it("keeps italic instructions that only start with an action verb", () => {
		expect(
			stripAssistantStageDirections(
				"Please *look at the stack trace* before retrying.",
			),
		).toBe("Please *look at the stack trace* before retrying.");
		expect(
			stripAssistantStageDirections(
				"Please *point to the failing test* and I will fix it.",
			),
		).toBe("Please *point to the failing test* and I will fix it.");
		expect(
			stripAssistantStageDirections("The result *looks correct* now."),
		).toBe("The result *looks correct* now.");
	});

	it("keeps a fenced action verbatim", () => {
		expect(stripAssistantStageDirections("```\n*smiles*\n```")).toBe(
			"```\n*smiles*\n```",
		);
	});
});
