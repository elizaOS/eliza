/**
 * Unit tests (deterministic, no runtime) for
 * `ExperienceRelationshipManager.findContradictions`. A contradiction can be
 * detected by two independent signals -- same action + opposite outcome in one
 * domain, or an explicit `contradicts` link. An experience matching both was
 * pushed twice, so the caller (`ExperienceService`) then added duplicate
 * `contradicts` edges. These tests pin de-duplication while keeping both
 * detection paths intact.
 */
import { describe, expect, it } from "vitest";
import type { UUID } from "../../../../types/primitives.ts";
import type { Experience } from "../types";
import { ExperienceType, OutcomeType } from "../types";
import { ExperienceRelationshipManager } from "./experienceRelationships";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;

function makeExperience(
	id: string,
	overrides: Partial<Experience> = {},
): Experience {
	return {
		id: id as UUID,
		agentId: AGENT_ID,
		type: ExperienceType.LEARNING,
		outcome: OutcomeType.POSITIVE,
		context: "ctx",
		action: "deploy",
		result: "res",
		learning: `learning ${id}`,
		tags: [],
		domain: "shell",
		keywords: [],
		associatedEntityIds: [],
		confidence: 0.8,
		importance: 0.7,
		createdAt: 0,
		updatedAt: 0,
		accessCount: 0,
		...overrides,
	};
}

describe("ExperienceRelationshipManager.findContradictions", () => {
	it("returns an experience once when it matches both detection paths", () => {
		const manager = new ExperienceRelationshipManager();
		const base = makeExperience("A", { outcome: OutcomeType.POSITIVE });
		// Same action + opposite outcome + same domain AND an explicit link.
		const other = makeExperience("B", { outcome: OutcomeType.NEGATIVE });
		manager.addRelationship({
			fromId: "A",
			toId: "B",
			type: "contradicts",
			strength: 1,
		});

		const result = manager.findContradictions(base, [base, other]);

		expect(result.filter((e) => e.id === other.id)).toHaveLength(1);
	});

	it("detects a same-action/opposite-outcome contradiction", () => {
		const manager = new ExperienceRelationshipManager();
		const base = makeExperience("A", { outcome: OutcomeType.POSITIVE });
		const other = makeExperience("C", { outcome: OutcomeType.NEGATIVE });

		const result = manager.findContradictions(base, [base, other]);

		expect(result.map((e) => e.id)).toEqual(["C"]);
	});

	it("detects an explicit contradicts link across a different action", () => {
		const manager = new ExperienceRelationshipManager();
		const base = makeExperience("A", { outcome: OutcomeType.POSITIVE });
		const other = makeExperience("D", {
			action: "build",
			outcome: OutcomeType.POSITIVE,
			domain: "ci",
		});
		manager.addRelationship({
			fromId: "A",
			toId: "D",
			type: "contradicts",
			strength: 1,
		});

		const result = manager.findContradictions(base, [base, other]);

		expect(result.map((e) => e.id)).toEqual(["D"]);
	});
});
