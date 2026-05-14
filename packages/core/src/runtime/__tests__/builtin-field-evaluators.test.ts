import { describe, expect, it } from "vitest";
import { candidateActionNamesFieldEvaluator } from "../builtin-field-evaluators";

describe("candidateActionNamesFieldEvaluator", () => {
	it("normalizes emitted action hints toward native planner tool names", () => {
		expect(
			candidateActionNamesFieldEvaluator.parse([
				" play music ",
				"play-music",
				"PLAY_MUSIC",
				"tasks:spawn:agent",
				"",
				null,
			]),
		).toEqual(["PLAY_MUSIC", "TASKS_SPAWN_AGENT"]);
	});

	it("caps candidate action hints before they reach planner retrieval", () => {
		const values = Array.from({ length: 20 }, (_, index) => `action ${index}`);

		expect(candidateActionNamesFieldEvaluator.parse(values)).toHaveLength(12);
	});
});
