/**
 * Unit tests for adversarial model fixtures: validates catalogue constants,
 * description map, and planner fixture generators.
 */
import { describe, expect, it } from "vitest";
import {
	ADVERSARIAL_KIND_DESCRIPTIONS,
	ADVERSARIAL_KINDS,
	adversarialActionRouteFixtures,
	adversarialPlannerFixture,
} from "./adversarial-model-fixtures.ts";

describe("adversarial-model-fixtures", () => {
	it("contains catalogue of expected adversarial kinds and descriptions", () => {
		expect(ADVERSARIAL_KINDS).toContain("malformed-json");
		expect(ADVERSARIAL_KINDS).toContain("wrong-tool");
		expect(ADVERSARIAL_KINDS).toContain("hallucinated-tool");
		expect(ADVERSARIAL_KINDS).toContain("empty");
		expect(ADVERSARIAL_KINDS).toContain("truncated");

		for (const kind of ADVERSARIAL_KINDS) {
			expect(ADVERSARIAL_KIND_DESCRIPTIONS[kind]).toBeDefined();
		}
	});

	it("creates adversarial planner fixture for malformed-json", () => {
		const fixture = adversarialPlannerFixture("malformed-json", {
			input: "search for weather",
			intendedAction: "SEARCH",
		});

		expect(fixture.name).toContain("adversarial-malformed-json-planner");
		expect(fixture.response).toContain("toolCalls");
	});

	it("creates adversarial planner fixture for wrong-tool and hallucinated-tool", () => {
		const wrong = adversarialPlannerFixture("wrong-tool", {
			input: "search for weather",
			intendedAction: "SEARCH",
			wrongToolName: "CUSTOM_WRONG",
		});
		expect(wrong.response).toHaveProperty("toolCalls");

		const hallucinated = adversarialPlannerFixture("hallucinated-tool", {
			input: "search for weather",
			intendedAction: "SEARCH",
			hallucinatedToolName: "CUSTOM_FAKE",
		});
		expect(hallucinated.response).toHaveProperty("toolCalls");
	});

	it("creates complete turn route fixtures pair", () => {
		const fixtures = adversarialActionRouteFixtures("empty", {
			input: "test command",
			intendedAction: "EXECUTE",
		});

		expect(fixtures.length).toBe(2);
	});
});
