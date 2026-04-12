/**
 * Standalone Ax AI instances for GEPA/ACE (Phase 4).
 *
 * **WHY not `runtime.useModel`:** GEPA/ACE depend on `AxAIService` — multi-turn
 * `chat`, optional tools/streaming, embeddings, and provider-specific request
 * shaping. Eliza’s hot path is string-in/string-out per model registration;
 * reimplementing Ax’s surface on top of it would duplicate every provider SDK
 * and break when Ax adds methods.
 *
 * **WHY `readOptimizationAIConfig` returns `null`:** Callers treat “no config”
 * as “skip AI stages” so missing env/settings never throw at startup; adapters
 * throw only after confirming Ax is loaded and the operator expected AI stages.
 *
 * **WHY student vs teacher:** Ax separates cheap rollouts (student) from
 * reflection/curation (teacher). Defaults mirror the student so single-model
 * setups work without extra keys.
 *
 * **WHY inherit Eliza settings:** Operators already set `OLLAMA_*`, `OPENAI_*`,
 * etc. for inference. Missing `OPTIMIZATION_AI_*` fields are backfilled using the
 * same prefix + fallback-slot order as `AgentRuntime.resolveProviderModelString`
 * so the optimizer targets the same provider/model family unless overridden.
 * Set `OPTIMIZATION_AI_INHERIT=false` to require an explicit student trio.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
	ModelType,
	getModelFallbackChain,
	type ModelTypeName,
} from "@elizaos/core";

export interface OptimizationAIConfig {
	/** Ax provider name, e.g. "openai", "anthropic", "google-gemini", "ollama", "openrouter" */
	provider: string;
	apiKey: string;
	model: string;
	teacherProvider?: string;
	teacherApiKey?: string;
	teacherModel?: string;
}

function trimString(v: unknown): string | undefined {
	if (v == null) return undefined;
	if (typeof v === "string") {
		const t = v.trim();
		return t.length > 0 ? t : undefined;
	}
	return undefined;
}

/** Same slot → env key map as `AgentRuntime.resolveProviderModelString`. */
const SLOT_TO_SETTING: Record<string, string> = {
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

const PROVIDER_PREFIX_ORDER = ["OLLAMA_", "OPENAI_", "ANTHROPIC_", ""] as const;

type Binding = {
	axProvider: string;
	model: string;
};

function axProviderFromPrefix(prefix: string): string {
	if (prefix === "OLLAMA_") return "ollama";
	if (prefix === "OPENAI_") return "openai";
	if (prefix === "ANTHROPIC_") return "anthropic";
	return "";
}

/**
 * First non-empty `${prefix}${settingKey}` model string, mirroring runtime
 * resolution order; records which prefix won for provider tagging.
 */
function resolveModelBindingFromRuntime(
	get: (key: string) => unknown,
	logicalSlot: ModelTypeName,
): Binding | null {
	for (const candidate of getModelFallbackChain(logicalSlot)) {
		const settingKey = SLOT_TO_SETTING[candidate];
		if (!settingKey) continue;

		for (const prefix of PROVIDER_PREFIX_ORDER) {
			const model = trimString(get(`${prefix}${settingKey}`));
			if (!model) continue;
			const axProvider = axProviderFromPrefix(prefix);
			if (axProvider) return { axProvider, model };
		}

		const unprefixed = trimString(get(settingKey));
		if (!unprefixed) continue;

		if (trimString(get("OPENAI_API_KEY")))
			return { axProvider: "openai", model: unprefixed };
		if (trimString(get("ANTHROPIC_API_KEY")))
			return { axProvider: "anthropic", model: unprefixed };
		if (
			trimString(get("OLLAMA_API_ENDPOINT")) ||
			trimString(get("OLLAMA_API_URL"))
		) {
			return { axProvider: "ollama", model: unprefixed };
		}
		// Local / Ollama-first harnesses often only set unprefixed SMALL_MODEL.
		return { axProvider: "ollama", model: unprefixed };
	}
	return null;
}

function apiKeyForAxProvider(
	get: (key: string) => unknown,
	axProvider: string,
): string | undefined {
	const t = (k: string) => trimString(get(k));
	if (axProvider === "openai") return t("OPENAI_API_KEY");
	if (axProvider === "anthropic") return t("ANTHROPIC_API_KEY");
	if (axProvider === "ollama") return t("OLLAMA_API_KEY") ?? "ollama";
	return undefined;
}

function optimizationAiInheritDisabled(runtime: IAgentRuntime): boolean {
	const raw = runtime.getSetting?.("OPTIMIZATION_AI_INHERIT");
	if (raw === false || raw === 0) return true;
	if (typeof raw === "string") {
		const s = raw.trim().toLowerCase();
		return s === "false" || s === "0" || s === "no" || s === "off";
	}
	return false;
}

function inheritLogicalSlot(runtime: IAgentRuntime): ModelTypeName {
	const s = trimString(runtime.getSetting?.("OPTIMIZATION_AI_INHERIT_SLOT"));
	if (s === "TEXT_LARGE" || s === "LARGE") return ModelType.TEXT_LARGE;
	return ModelType.TEXT_SMALL;
}

/**
 * Read optimization AI settings from runtime. Returns null if required keys are missing
 * so GEPA/ACE keep their stub fallbacks (adopted: false).
 *
 * Precedence: explicit `OPTIMIZATION_AI_*` wins per field. Other fields are filled from
 * Eliza’s model env (same order as `resolveProviderModelString`) unless
 * `OPTIMIZATION_AI_INHERIT` is disabled.
 */
export function readOptimizationAIConfig(
	runtime: IAgentRuntime,
): OptimizationAIConfig | null {
	const get = (key: string): unknown => runtime.getSetting?.(key);

	let provider = trimString(get("OPTIMIZATION_AI_PROVIDER"));
	let apiKey = trimString(get("OPTIMIZATION_AI_API_KEY"));
	let model = trimString(get("OPTIMIZATION_AI_MODEL"));

	const allowInherit = !optimizationAiInheritDisabled(runtime);
	if (allowInherit) {
		const binding = resolveModelBindingFromRuntime(
			get,
			inheritLogicalSlot(runtime),
		);
		if (binding) {
			if (!provider) provider = binding.axProvider;
			if (!model) model = binding.model;
		}
		if (!provider) {
			if (trimString(get("OPENAI_API_KEY"))) provider = "openai";
			else if (trimString(get("ANTHROPIC_API_KEY"))) provider = "anthropic";
			else provider = "ollama";
		}
		if (!apiKey && provider) {
			apiKey = apiKeyForAxProvider(get, provider);
		}
	}

	if (!provider || !apiKey || !model) return null;

	return {
		provider,
		apiKey,
		model,
		teacherProvider: trimString(get("OPTIMIZATION_TEACHER_PROVIDER")),
		teacherApiKey: trimString(get("OPTIMIZATION_TEACHER_API_KEY")),
		teacherModel: trimString(get("OPTIMIZATION_TEACHER_MODEL")),
	};
}

type AxAIModule = typeof import("@ax-llm/ax");

function axCreateOptions(
	provider: string,
	apiKey: string,
	model: string,
): Parameters<AxAIModule["AxAI"]["create"]>[0] {
	// `name` is a discriminated-union tag in @ax-llm/ax; provider comes from settings.
	return {
		name: provider,
		apiKey,
		config: { model },
	} as Parameters<AxAIModule["AxAI"]["create"]>[0];
}

/**
 * Create student AxAI via AxAI.create (preferred in @ax-llm/ax v19+).
 */
export function createStudentAI(ax: AxAIModule, config: OptimizationAIConfig) {
	return ax.AxAI.create(
		axCreateOptions(config.provider, config.apiKey, config.model),
	);
}

export function createTeacherAI(ax: AxAIModule, config: OptimizationAIConfig) {
	const provider = config.teacherProvider?.trim() || config.provider;
	const apiKey = config.teacherApiKey?.trim() || config.apiKey;
	const model = config.teacherModel?.trim() || config.model;
	return ax.AxAI.create(axCreateOptions(provider, apiKey, model));
}
