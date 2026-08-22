/**
 * Deterministic prompt-metadata coverage proving that every loaded skill is
 * retained even when a legacy caller supplies the retired maxSkills option.
 */

import { describe, expect, it } from "vitest";
import type { SkillMetadataEntry } from "../types";
import { AgentSkillsService } from "./skills";

describe("AgentSkillsService prompt metadata", () => {
	it("includes every loaded skill instead of applying a first-N prefix", () => {
		const metadata: SkillMetadataEntry[] = Array.from(
			{ length: 12 },
			(_, index) => ({
				name: `skill-${index + 1}`,
				description: `Skill ${index + 1} description`,
				location: `/skills/skill-${index + 1}/SKILL.md`,
			}),
		);
		const service = Object.create(
			AgentSkillsService.prototype,
		) as AgentSkillsService;
		service.getSkillsMetadata = () => metadata;

		const promptJson = service.generateSkillsPromptJson({ maxSkills: 3 });

		expect(promptJson).toContain("skill-1");
		expect(promptJson).toContain("skill-12");
	});
});
