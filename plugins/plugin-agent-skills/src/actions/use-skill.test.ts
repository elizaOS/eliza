import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { useSkillAction } from "./use-skill";

describe("useSkillAction", () => {
	it("reads planned action arguments from handler parameters", async () => {
		const skill = {
			slug: "github",
			name: "GitHub",
			description: "GitHub workflow guidance",
			version: "1.0.0",
			content: "",
			frontmatter: {},
			path: "/skills/github",
			scripts: [],
			references: [],
			assets: [],
			loadedAt: 0,
			source: "bundled",
		};
		const service = {
			getLoadedSkill: vi.fn((slug: string) =>
				slug === "github" ? skill : undefined,
			),
			getLoadedSkills: vi.fn(() => [skill]),
			isSkillEnabled: vi.fn(() => true),
			checkSkillEligibility: vi.fn(async () => ({
				slug: "github",
				eligible: true,
				reasons: [],
				checkedAt: 0,
			})),
			getSkillInstructions: vi.fn(() => ({
				slug: "github",
				body: "Use the repository host's API and local git state.",
				estimatedTokens: 12,
			})),
		};
		const runtime = {
			getService: vi.fn((name: string) =>
				name === "AGENT_SKILLS_SERVICE" ? service : undefined,
			),
		} as unknown as IAgentRuntime;
		const callback = vi.fn();

		const result = await useSkillAction.handler(
			runtime,
			{ content: { text: "use github skill" } } as Memory,
			undefined,
			{ parameters: { slug: "github", mode: "guidance" } },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.data).toMatchObject({
			slug: "github",
			mode: "guidance",
		});
		expect(callback).toHaveBeenCalledWith({
			text: expect.stringContaining("Use the repository host's API"),
			actions: ["USE_SKILL"],
		});
		expect(service.getLoadedSkill).toHaveBeenCalledWith("github");
	});
});
