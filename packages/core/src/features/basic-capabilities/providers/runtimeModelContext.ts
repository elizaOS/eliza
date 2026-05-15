import type {
	IAgentRuntime,
	Memory,
	ModelTypeName,
	Provider,
	State,
} from "../../../types/index.ts";
import { getModelFallbackChain, ModelType } from "../../../types/model.ts";

type RuntimeWithModelHelpers = IAgentRuntime & {
	resolveProviderModelString?: (
		resolvedModelType: string,
		optionsModel?: string,
		effectiveModelId?: string,
	) => string;
	models?: Map<string, Array<{ provider?: string }>>;
};

const MODEL_SETTING_SUFFIX: Record<string, string> = {
	[ModelType.TEXT_NANO]: "NANO_MODEL",
	[ModelType.TEXT_SMALL]: "SMALL_MODEL",
	[ModelType.TEXT_MEDIUM]: "MEDIUM_MODEL",
	[ModelType.TEXT_LARGE]: "LARGE_MODEL",
	[ModelType.TEXT_MEGA]: "MEGA_MODEL",
	[ModelType.RESPONSE_HANDLER]: "RESPONSE_HANDLER_MODEL",
	[ModelType.ACTION_PLANNER]: "ACTION_PLANNER_MODEL",
	[ModelType.TEXT_REASONING_SMALL]: "REASONING_SMALL_MODEL",
	[ModelType.TEXT_REASONING_LARGE]: "REASONING_LARGE_MODEL",
	[ModelType.TEXT_COMPLETION]: "COMPLETION_MODEL",
};

const MODEL_PROVIDER_PREFIXES = ["OLLAMA_", "OPENAI_", "ANTHROPIC_", ""];
const MODEL_CONTEXT_TERMS = new Set([
	"model",
	"models",
	"llm",
	"provider",
	"providers",
	"gpt",
	"claude",
	"sonnet",
]);
const REQUEST_CONTEXT_TERMS = new Set([
	"what",
	"which",
	"who",
	"how",
	"tell",
	"show",
	"list",
	"name",
	"identify",
]);
const SELF_MODEL_CONTEXT_TERMS = new Set([
	"you",
	"your",
	"yours",
	"agent",
	"assistant",
	"bot",
	"runtime",
	"system",
	"current",
	"using",
	"running",
	"powered",
	"configured",
	"default",
]);
const CODING_AGENT_CONTEXT_TERMS = new Set([
	"opencode",
	"codex",
	"claude",
	"gemini",
	"aider",
]);

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
	const value = runtime.getSetting(key);
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function fallbackModelString(
	runtime: IAgentRuntime,
	modelType: ModelTypeName,
): string {
	for (const candidate of getModelFallbackChain(modelType)) {
		const suffix = MODEL_SETTING_SUFFIX[candidate];
		if (!suffix) continue;
		for (const prefix of MODEL_PROVIDER_PREFIXES) {
			const configured = readSetting(runtime, `${prefix}${suffix}`);
			if (configured) return configured;
		}
	}
	return String(modelType);
}

function configuredModelString(
	runtime: RuntimeWithModelHelpers,
	modelType: ModelTypeName,
): string {
	if (typeof runtime.resolveProviderModelString === "function") {
		return runtime.resolveProviderModelString(modelType);
	}
	return fallbackModelString(runtime, modelType);
}

function registeredProviderFor(
	runtime: RuntimeWithModelHelpers,
	modelType: ModelTypeName,
): string | undefined {
	for (const candidate of getModelFallbackChain(modelType)) {
		const provider = runtime.models?.get(candidate)?.[0]?.provider?.trim();
		if (provider) return provider;
	}
	return undefined;
}

function optionalLine(label: string, value: string | undefined): string | null {
	return value ? `- ${label}: ${value}` : null;
}

function tokenize(text: string): Set<string> {
	return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function shouldRenderRuntimeModelContext(message: Memory): boolean {
	if (
		message.content.source === "sub_agent" ||
		(message.content.metadata &&
			typeof message.content.metadata === "object" &&
			(message.content.metadata as Record<string, unknown>).subAgent === true)
	) {
		return false;
	}

	const text =
		typeof message.content.text === "string" ? message.content.text : "";
	const tokens = tokenize(text);
	if (tokens.size === 0) return false;

	const hasRequestCue =
		text.includes("?") ||
		[...REQUEST_CONTEXT_TERMS].some((term) => tokens.has(term));
	if (!hasRequestCue) return false;

	const hasModelTerm = [...MODEL_CONTEXT_TERMS].some((term) =>
		tokens.has(term),
	);
	const hasSelfTerm = [...SELF_MODEL_CONTEXT_TERMS].some((term) =>
		tokens.has(term),
	);
	if (hasModelTerm && hasSelfTerm) return true;

	const hasCodingAgentTerm =
		(tokens.has("coding") && tokens.has("agent")) ||
		(tokens.has("sub") && tokens.has("agent")) ||
		[...CODING_AGENT_CONTEXT_TERMS].some((term) => tokens.has(term));
	return hasCodingAgentTerm && hasSelfTerm;
}

export const runtimeModelContextProvider: Provider = {
	name: "RUNTIME_MODEL_CONTEXT",
	description:
		"Current runtime model configuration for answering questions about which model/provider powers the agent.",
	descriptionCompressed:
		"Current runtime model slots and coding sub-agent model configuration.",
	dynamic: true,
	position: -8,
	contexts: ["general"],
	contextGate: { anyOf: ["general"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },
	relevanceKeywords: [
		"model",
		"provider",
		"llm",
		"gpt",
		"claude",
		"sonnet",
		"opencode",
	],

	get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
		if (!shouldRenderRuntimeModelContext(message)) {
			return { text: "", values: {}, data: {} };
		}

		const runtimeWithModels = runtime as RuntimeWithModelHelpers;
		const responseHandlerModel = configuredModelString(
			runtimeWithModels,
			ModelType.RESPONSE_HANDLER,
		);
		const actionPlannerModel = configuredModelString(
			runtimeWithModels,
			ModelType.ACTION_PLANNER,
		);
		const textLargeModel = configuredModelString(
			runtimeWithModels,
			ModelType.TEXT_LARGE,
		);
		const textSmallModel = configuredModelString(
			runtimeWithModels,
			ModelType.TEXT_SMALL,
		);
		const defaultAgentType = readSetting(runtime, "ELIZA_DEFAULT_AGENT_TYPE");
		const opencodeModel =
			readSetting(runtime, "ELIZA_OPENCODE_MODEL_POWERFUL") ??
			readSetting(runtime, "ELIZA_OPENCODE_MODEL_FAST");

		const responseHandlerProvider = registeredProviderFor(
			runtimeWithModels,
			ModelType.RESPONSE_HANDLER,
		);
		const actionPlannerProvider = registeredProviderFor(
			runtimeWithModels,
			ModelType.ACTION_PLANNER,
		);

		const lines = [
			"# Runtime Model Context",
			"Use these runtime facts when asked what model, provider, or coding agent is currently in use. Do not infer a different model from training data or old chat history.",
			`- Response handler model: ${responseHandlerModel}`,
			`- Action planner model: ${actionPlannerModel}`,
			`- Large text model: ${textLargeModel}`,
			`- Small text model: ${textSmallModel}`,
			optionalLine("Response handler provider", responseHandlerProvider),
			optionalLine("Action planner provider", actionPlannerProvider),
			optionalLine("Default coding sub-agent", defaultAgentType),
			optionalLine("OpenCode model", opencodeModel),
		].filter((line): line is string => line !== null);

		return {
			text: lines.join("\n"),
			values: {
				responseHandlerModel,
				actionPlannerModel,
				textLargeModel,
				textSmallModel,
				defaultAgentType,
				opencodeModel,
			},
			data: {
				responseHandlerModel,
				actionPlannerModel,
				textLargeModel,
				textSmallModel,
				responseHandlerProvider,
				actionPlannerProvider,
				defaultAgentType,
				opencodeModel,
			},
		};
	},
};
