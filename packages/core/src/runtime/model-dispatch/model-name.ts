import {
	getModelFallbackChain,
	type IAgentRuntime,
	type ModelTypeName,
} from "../../types";
export function resolveProviderModelString(
	runtime: IAgentRuntime,
	resolvedModelType: string,
	optionsModel?: string,
	effectiveModelId?: string,
): string {
	if (effectiveModelId) return effectiveModelId;
	if (optionsModel) return optionsModel;

	const slotToSetting: Record<string, string> = {
		TEXT_NANO: "NANO_MODEL",
		TEXT_MINI: "MINI_MODEL",
		TEXT_SMALL: "SMALL_MODEL",
		TEXT_LARGE: "LARGE_MODEL",
		TEXT_MEGA: "MEGA_MODEL",
		RESPONSE_HANDLER: "RESPONSE_HANDLER_MODEL",
		ACTION_PLANNER: "ACTION_PLANNER_MODEL",
		REASONING_SMALL: "REASONING_SMALL_MODEL",
		REASONING_LARGE: "REASONING_LARGE_MODEL",
		TEXT_COMPLETION: "COMPLETION_MODEL",
	};

	const providerPrefixes = ["OLLAMA_", "OPENAI_", "ANTHROPIC_", ""];
	for (const candidate of getModelFallbackChain(
		resolvedModelType as ModelTypeName,
	)) {
		const settingKey = slotToSetting[candidate];
		if (!settingKey) continue;
		for (const prefix of providerPrefixes) {
			const val = runtime.getSetting(`${prefix}${settingKey}`);
			if (typeof val === "string" && val) return val;
		}
	}

	return resolvedModelType;
}
