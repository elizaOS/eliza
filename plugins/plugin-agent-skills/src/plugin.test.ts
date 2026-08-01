/** Verifies loaded skills contribute commands without a delayed retry timer. */
import type { CommandRegistryService, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { registerLoadedSkillCommands } from "./commands";
import type { AgentSkillsService } from "./services/skills";

describe("registerLoadedSkillCommands", () => {
	it("registers every loaded skill on the runtime command service", () => {
		const register = vi.fn();
		const runtime = {
			getService: vi.fn(() => ({ register }) as unknown as CommandRegistryService),
		} as unknown as IAgentRuntime;
		const service = {
			getLoadedSkills: () => [
				{ slug: "Web-Search", description: "Search the web" },
				{ slug: "calendar", description: "Manage calendar events" },
			],
		} as unknown as AgentSkillsService;

		expect(registerLoadedSkillCommands(runtime, service)).toBe(2);
		expect(register).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				key: "skill-web-search",
				textAliases: ["/web-search"],
			}),
		);
		expect(register).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ key: "skill-calendar" }),
		);
	});

	it("is a no-op when the commands plugin is absent", () => {
		const runtime = {
			getService: vi.fn(() => null),
		} as unknown as IAgentRuntime;
		const service = {
			getLoadedSkills: () => [{ slug: "calendar", description: "Calendar" }],
		} as unknown as AgentSkillsService;

		expect(registerLoadedSkillCommands(runtime, service)).toBe(0);
	});
});
