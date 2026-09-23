/**
 * Unit tests for CommandRegistryService: the canonical `commands` service type,
 * per-runtime command stores, skills-bridge coexistence, and replace-by-key
 * semantics. Runs against a stub runtime, no live model.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { CommandRegistryService } from "../src/command-registry-service";
import { initForRuntime } from "../src/registry";
import type { CommandDefinition } from "../src/types";

/**
 * The CommandRegistryService is the runtime seam hosts and other plugins use to
 * contribute commands (item #12091-15) — replacing a dynamic import of the
 * plugin's module-level registry. Registrations must land on the queried
 * runtime's store and must NOT reset commands registered by earlier plugins.
 */

function fakeRuntime(agentId: string): IAgentRuntime {
	return { agentId } as unknown as IAgentRuntime;
}

const otherPluginCommand: CommandDefinition = {
	key: "other-plugin-cmd",
	description: "registered by a different plugin before the skills bridge",
	textAliases: ["/other"],
	scope: "both",
	category: "tools",
};

function skillCommand(slug: string): CommandDefinition {
	return {
		key: `skill-${slug}`,
		description: `${slug} skill`,
		textAliases: [`/${slug}`],
		scope: "both",
		category: "skills",
		acceptsArgs: true,
		args: [
			{
				name: "input",
				description: "Task or question for this skill",
				captureRemaining: true,
			},
		],
	};
}

describe("CommandRegistryService", () => {
	it("exposes the canonical 'commands' service type", () => {
		expect(CommandRegistryService.serviceType).toBe("commands");
	});

	it("registers a command on the queried runtime's store", async () => {
		const agentId = "svc-agent-a";
		initForRuntime(agentId);
		const service = await CommandRegistryService.start(fakeRuntime(agentId));

		service.register(otherPluginCommand);

		const keys = service.list().map((c) => c.key);
		expect(keys).toContain("other-plugin-cmd");
		// Built-in defaults remain.
		expect(keys).toContain("help");
	});

	it("keeps other plugins' commands alive across skills-bridge registration", async () => {
		const agentId = "svc-agent-b";
		initForRuntime(agentId);
		const service = await CommandRegistryService.start(fakeRuntime(agentId));

		// Another plugin registers first.
		service.register(otherPluginCommand);

		// The skills bridge then registers skill commands through the same seam
		// (no initForRuntime, so nothing is reset).
		for (const slug of ["research", "plan", "recap"]) {
			service.register(skillCommand(slug));
		}

		const keys = service.list().map((c) => c.key);
		expect(keys).toContain("other-plugin-cmd");
		expect(keys).toContain("skill-research");
		expect(keys).toContain("skill-plan");
		expect(keys).toContain("skill-recap");
	});

	it("replaces by key rather than duplicating", async () => {
		const agentId = "svc-agent-c";
		initForRuntime(agentId);
		const service = await CommandRegistryService.start(fakeRuntime(agentId));

		service.register(skillCommand("dupe"));
		service.register({ ...skillCommand("dupe"), description: "updated" });

		const matches = service.list().filter((c) => c.key === "skill-dupe");
		expect(matches).toHaveLength(1);
		expect(matches[0].description).toBe("updated");
	});
});
