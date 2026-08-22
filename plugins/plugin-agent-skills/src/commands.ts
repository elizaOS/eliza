/** Contributes loaded Agent Skills to the shared runtime command registry. */

import {
	type CommandRegistryService,
	type IAgentRuntime,
	toWellFormedUnicode,
} from "@elizaos/core";
import type { AgentSkillsService } from "./services/skills";

type LoadedSkillsReader = Pick<AgentSkillsService, "getLoadedSkills">;
type CommandsWriter = Pick<CommandRegistryService, "register">;

/** Register every loaded skill after skills and commands services are ready. */
export function registerLoadedSkillCommands(
	runtime: IAgentRuntime,
	service: LoadedSkillsReader,
	commands: CommandsWriter | null =
		runtime.getService<CommandRegistryService>("commands"),
): number {
	if (!commands) return 0;

	let registered = 0;
	for (const skill of service.getLoadedSkills()) {
		const slug = skill.slug.toLowerCase();
		commands.register({
			key: `skill-${slug}`,
			description: toWellFormedUnicode(skill.description),
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
		});
		registered += 1;
	}
	return registered;
}
