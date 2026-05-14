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
});
