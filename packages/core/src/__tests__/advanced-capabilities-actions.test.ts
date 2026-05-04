import { describe, expect, it } from "vitest";
import {
	advancedActions,
	advancedEvaluators,
	advancedProviders,
} from "../features/advanced-capabilities/index.ts";

describe("advancedActions", () => {
	it("exposes SAVE_ATTACHMENT_TO_CLIPBOARD as a selectable advanced action", () => {
		expect(advancedActions.map((action) => action.name)).toContain(
			"SAVE_ATTACHMENT_TO_CLIPBOARD",
		);
	});

	it("exposes task creation, memory providers, and memory evaluators", () => {
		expect(advancedActions.map((action) => action.name)).toContain(
			"CREATE_TASK",
		);
		expect(advancedProviders.map((provider) => provider.name)).toEqual(
			expect.arrayContaining([
				"CONTACTS",
				"FACTS",
				"FOLLOW_UPS",
				"KNOWLEDGE",
				"RELATIONSHIPS",
			]),
		);
		expect(advancedEvaluators.map((evaluator) => evaluator.name)).toEqual(
			expect.arrayContaining([
				"FACT_EXTRACTOR",
				"REFLECTION",
				"RELATIONSHIP_EXTRACTION",
				"SKILL_EXTRACTION",
				"SKILL_REFINEMENT",
			]),
		);
	});
});
