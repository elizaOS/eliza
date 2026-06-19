import type { Action, IAgentRuntime } from "@elizaos/core";
import type { AgentSkillsService } from "../services/skills";

type ActionValidate = NonNullable<Action["validate"]>;

interface AgentSkillsValidatorConfig {
	readonly keywords: readonly string[];
	readonly regex: RegExp;
}

function hasAgentSkillsService(runtime: IAgentRuntime): boolean {
	const service = runtime.getService<AgentSkillsService>(
		"AGENT_SKILLS_SERVICE",
	);
	return Boolean(service);
}

export function createAgentSkillsActionValidator(
	_config: AgentSkillsValidatorConfig,
): ActionValidate {
	return async (
		runtime: IAgentRuntime,
	): Promise<boolean> => {
		try {
			return hasAgentSkillsService(runtime);
		} catch {
			return false;
		}
	};
}
