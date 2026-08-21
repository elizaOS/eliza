/**
 * Agent Skills service tests verify that ambient script credentials are scoped
 * to the trusted bundled skill that declares them.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySkillStore } from "../storage";
import type { LoadedSkillWithSource, SkillSource } from "../types";
import { AgentSkillsService } from "./skills";

function createRuntime(): IAgentRuntime {
	return {
		getSetting: vi.fn(() => undefined),
		logger: {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

function createScriptSkill(source: SkillSource): LoadedSkillWithSource {
	return {
		slug: `${source}-image-script`,
		name: `${source} image script`,
		description: "Test script",
		version: "1.0.0",
		content: "",
		frontmatter: {
			metadata: { otto: { requires: { env: ["GEMINI_API_KEY"] } } },
		},
		path: `/skills/${source}-image-script`,
		scripts: ["run.mjs"],
		references: [],
		assets: [],
		loadedAt: 0,
		source,
		sourceDir: `/skills/${source}`,
		precedence: 0,
	};
}

function registerSkill(
	service: AgentSkillsService,
	skill: LoadedSkillWithSource,
): void {
	const internals = service as unknown as {
		loadedSkills: Map<string, LoadedSkillWithSource>;
	};
	internals.loadedSkills.set(skill.slug, skill);
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("Agent Skills script environment scoping", () => {
	it("passes a declared ambient credential to its bundled script", async () => {
		vi.stubEnv("GEMINI_API_KEY", "bundled-image-key");
		const service = new AgentSkillsService(createRuntime(), {
			autoLoad: false,
			storage: new MemorySkillStore(),
		});
		const skill = createScriptSkill("bundled");
		registerSkill(service, skill);

		expect((await service.checkSkillEligibility(skill)).eligible).toBe(true);
		expect(service.getSkillExecutionEnv(skill.slug).GEMINI_API_KEY).toBe(
			"bundled-image-key",
		);
	});

	it("withholds the same ambient credential from an installed script", async () => {
		vi.stubEnv("GEMINI_API_KEY", "ambient-host-key");
		const service = new AgentSkillsService(createRuntime(), {
			autoLoad: false,
			storage: new MemorySkillStore(),
		});
		const skill = createScriptSkill("managed");
		registerSkill(service, skill);

		const eligibility = await service.checkSkillEligibility(skill);
		expect(eligibility.eligible).toBe(false);
		expect(eligibility.reasons[0]?.message).toContain("is not passed");
		expect(service.getSkillExecutionEnv(skill.slug)).not.toHaveProperty(
			"GEMINI_API_KEY",
		);
	});
});
