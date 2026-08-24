/**
 * Unit tests for commands registration: validates registering loaded skills
 * as runtime slash commands.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { registerLoadedSkillCommands } from "./commands.ts";

describe("agent-skills commands", () => {
	it("returns 0 when commands service is null", () => {
		const runtime = {
			getService: () => null,
		} as unknown as IAgentRuntime;
		const service = {
			getLoadedSkills: () => [{ slug: "code-review", description: "Review code" }],
		} as any;

		const count = registerLoadedSkillCommands(runtime, service, null);
		expect(count).toBe(0);
	});

	it("registers loaded skills into commands service", () => {
		const registeredCommands: any[] = [];
		const commandsWriter = {
			register: (cmd: any) => registeredCommands.push(cmd),
		};
		const runtime = {
			getService: () => commandsWriter,
		} as unknown as IAgentRuntime;

		const service = {
			getLoadedSkills: () => [
				{ slug: "git-commit", description: "Create git commit" },
				{ slug: "run-tests", description: "Run test suites" },
			],
		} as any;

		const count = registerLoadedSkillCommands(runtime, service, commandsWriter as any);
		expect(count).toBe(2);
		expect(registeredCommands.length).toBe(2);
		expect(registeredCommands[0].key).toBe("skill-git-commit");
		expect(registeredCommands[0].textAliases).toEqual(["/git-commit"]);
	});
});
