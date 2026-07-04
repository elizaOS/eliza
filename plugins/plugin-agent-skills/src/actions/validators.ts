/**
 * Shared `validate` factory for the skill catalog actions — gates each action
 * on the AGENT_SKILLS_SERVICE being registered on the runtime.
 */

import type { Action, IAgentRuntime } from "@elizaos/core";
import type { AgentSkillsService } from "../services/skills";

type ActionValidate = NonNullable<Action["validate"]>;

function hasAgentSkillsService(runtime: IAgentRuntime): boolean {
	const service = runtime.getService<AgentSkillsService>(
		"AGENT_SKILLS_SERVICE",
	);
	return Boolean(service);
}

export function createAgentSkillsActionValidator(): ActionValidate {
	return async (runtime: IAgentRuntime): Promise<boolean> => {
		try {
			return hasAgentSkillsService(runtime);
		} catch {
			return false;
		}
	};
}
