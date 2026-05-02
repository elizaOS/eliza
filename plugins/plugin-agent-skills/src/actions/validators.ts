import type { Action, IAgentRuntime, Memory, State } from "@elizaos/core";
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

function hasActionInput(message: Memory, options?: unknown): boolean {
	const text =
		typeof message.content?.text === "string" ? message.content.text : "";
	const optionValues =
		options && typeof options === "object"
			? (options as Record<string, unknown>)
			: {};
	return (
		text.trim().length > 0 ||
		Object.keys(optionValues).length > 0 ||
		Boolean(message.content && typeof message.content === "object")
	);
}

export function createAgentSkillsActionValidator(
	config: AgentSkillsValidatorConfig,
): ActionValidate {
	return async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: unknown,
	): Promise<boolean> => {
		const text =
			typeof message.content?.text === "string"
				? message.content.text.toLowerCase()
				: "";
		const keywordMatch = config.keywords.some(
			(keyword) => keyword.length > 0 && text.includes(keyword),
		);
		const regexMatch = config.regex.test(text);
		const source = String(message.content?.source ?? "");
		const sourceMatch = Boolean(
			source || state || runtime.agentId || runtime.getService,
		);

		if (
			!(
				keywordMatch &&
				regexMatch &&
				sourceMatch &&
				hasActionInput(message, options)
			)
		) {
			return false;
		}

		try {
			return hasAgentSkillsService(runtime);
		} catch {
			return false;
		}
	};
}
