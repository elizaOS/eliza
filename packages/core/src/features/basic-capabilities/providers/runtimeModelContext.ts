/**
 * RUNTIME_MODEL_CONTEXT provider — injects the agent's live model/provider
 * configuration into the prompt so it can answer "what model are you using?"
 * from real runtime facts instead of training-data guesses. Resolves each model
 * slot (response handler, action planner, large/small text) via the runtime
 * resolver, provider-declared display-model metadata, or the configured
 * `*_MODEL` settings/env keys, and reports the provider adapter name, endpoint
 * host, and the default coding sub-agent's model. Part of the basic-capabilities
 * bundle.
 *
 * Gated: `shouldRenderRuntimeModelContext` only fires for self-directed
 * model/provider/coding-agent questions and stays silent for sub-agent
 * transcripts and unrelated turns. A slot that stays unresolvable is OMITTED
 * rather than rendering its raw slot name (e.g. "RESPONSE_HANDLER") to the user.
 */

import type {
	IAgentRuntime,
	Memory,
	ModelRegistrationMetadata,
	ModelTypeName,
	Provider,
} from "../../../types/index.ts";
import { MESSAGE_SOURCE_SUB_AGENT } from "../../../types/message-source.ts";
import { getModelFallbackChain, ModelType } from "../../../types/model.ts";
import { readEnv } from "../../../utils/read-env.ts";

type RuntimeWithModelHelpers = IAgentRuntime & {
	resolveProviderModelString?: (
		resolvedModelType: string,
		optionsModel?: string,
		effectiveModelId?: string,
	) => string;
	models?: Map<
		string,
		Array<{ metadata?: ModelRegistrationMetadata; provider?: string }>
	>;
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
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length > 0) return trimmed;
	}
	// Many runtime model knobs are provided as ENV vars, which `getSetting` does
	// not expose — without this fallback every model slot rendered its raw slot
	// name ("TEXT_LARGE") and "what model are you using" leaked internals
	// instead of the real configured model id.
	const fromEnv = readEnv(key)?.trim();
	return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
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
): string | undefined {
	const resolved =
		typeof runtime.resolveProviderModelString === "function"
			? runtime.resolveProviderModelString(modelType)
			: undefined;
	if (resolved && resolved !== String(modelType)) return resolved;
	const registration = registeredModelFor(runtime, modelType);
	const displayModel = displayModelFor(runtime, registration?.metadata);
	if (displayModel) return displayModel;
	// Otherwise resolve from the configured *_MODEL keys along the fallback chain
	// (e.g. ANTHROPIC_LARGE_MODEL). If still unresolvable, return undefined so the
	// caller OMITS the line rather than leaking the raw slot name to the user.
	const configured = fallbackModelString(runtime, modelType);
	return configured && configured !== String(modelType)
		? configured
		: undefined;
}

function displayModelFor(
	runtime: IAgentRuntime,
	metadata: ModelRegistrationMetadata | undefined,
): string | undefined {
	if (!metadata) return undefined;
	if (typeof metadata.displayModel === "string") {
		const trimmed = metadata.displayModel.trim();
		if (trimmed) return trimmed;
	}
	if (typeof metadata.displayModelSetting === "string") {
		return readSetting(runtime, metadata.displayModelSetting);
	}
	return undefined;
}

function registeredModelFor(
	runtime: RuntimeWithModelHelpers,
	modelType: ModelTypeName,
): { metadata?: ModelRegistrationMetadata; provider?: string } | undefined {
	for (const candidate of getModelFallbackChain(modelType)) {
		const registration = runtime.models?.get(candidate)?.[0];
		if (registration) return registration;
	}
	return undefined;
}

function registeredProviderFor(
	runtime: RuntimeWithModelHelpers,
	modelType: ModelTypeName,
): string | undefined {
	const provider = registeredModelFor(runtime, modelType)?.provider?.trim();
	return provider || undefined;
}

function optionalLine(label: string, value: string | undefined): string | null {
	return value ? `- ${label}: ${value}` : null;
}

function endpointHost(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		return new URL(value).host;
	} catch {
		return undefined;
	}
}

function providerEndpointHost(
	runtime: IAgentRuntime,
	provider: string | undefined,
): string | undefined {
	if (!provider) return undefined;
	const prefix = provider
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (!prefix) return undefined;
	return endpointHost(readSetting(runtime, `${prefix}_BASE_URL`));
}

function tokenize(text: string): Set<string> {
	return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function shouldRenderRuntimeModelContext(message: Memory): boolean {
	if (
		message.content.source === MESSAGE_SOURCE_SUB_AGENT ||
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

	get: async (runtime: IAgentRuntime, message: Memory) => {
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
		const opencodeEndpointHost = endpointHost(
			readSetting(runtime, "ELIZA_OPENCODE_BASE_URL"),
		);

		const responseHandlerProvider = registeredProviderFor(
			runtimeWithModels,
			ModelType.RESPONSE_HANDLER,
		);
		const actionPlannerProvider = registeredProviderFor(
			runtimeWithModels,
			ModelType.ACTION_PLANNER,
		);
		const responseHandlerEndpointHost = providerEndpointHost(
			runtime,
			responseHandlerProvider,
		);
		const actionPlannerEndpointHost = providerEndpointHost(
			runtime,
			actionPlannerProvider,
		);

		const lines = [
			"# Runtime Model Context",
			"Use these runtime facts when asked what model, provider, or coding agent is currently in use. Provider adapter names may identify compatibility layers; endpoint hosts identify the configured backend when present. Do not infer a different model or provider from training data or old chat history.",
			optionalLine("Response handler model", responseHandlerModel),
			optionalLine("Action planner model", actionPlannerModel),
			optionalLine("Large text model", textLargeModel),
			optionalLine("Small text model", textSmallModel),
			optionalLine(
				"Response handler provider adapter",
				responseHandlerProvider,
			),
			optionalLine(
				"Response handler endpoint host",
				responseHandlerEndpointHost,
			),
			optionalLine("Action planner provider adapter", actionPlannerProvider),
			optionalLine("Action planner endpoint host", actionPlannerEndpointHost),
			optionalLine("Default coding sub-agent", defaultAgentType),
			optionalLine("OpenCode model", opencodeModel),
			optionalLine("OpenCode endpoint host", opencodeEndpointHost),
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
				opencodeEndpointHost,
			},
			data: {
				responseHandlerModel,
				actionPlannerModel,
				textLargeModel,
				textSmallModel,
				responseHandlerProvider,
				responseHandlerEndpointHost,
				actionPlannerProvider,
				actionPlannerEndpointHost,
				defaultAgentType,
				opencodeModel,
				opencodeEndpointHost,
			},
		};
	},
};
