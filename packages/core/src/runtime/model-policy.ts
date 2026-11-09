import { ElizaError } from "../errors.js";
import {
	getModelFallbackChain,
	type ModelHandler,
	type ModelRegistrationMetadata,
	ModelType,
	type ModelTypeName,
	type ResponseSkeleton,
	type StructuredStreamField,
	TEXT_GENERATION_MODEL_TYPES,
	type TextStreamResult,
} from "../types/model.js";
import type { JsonValue } from "../types/primitives.js";
import type { IAgentRuntime } from "../types/runtime.js";
import { assertModelOutputComplete } from "../utils/model-errors";
import { isPlainObject } from "../utils/type-guards";

/** Capability absence is recoverable; malformed input/output is not absence. */
export function isUnavailableLocalModel(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "LOCAL_INFERENCE_UNAVAILABLE" &&
		"reason" in error &&
		(error.reason === "backend_unavailable" ||
			error.reason === "capability_unavailable")
	);
}

/** Distinguishes absent model configuration from a deliberately disabled capability. */
export class NoModelProviderConfiguredError extends ElizaError {
	override readonly name = "NoModelProviderConfiguredError";
	readonly reason: "no-provider" | "capability-disabled";

	constructor(
		message: string = "This agent has no model provider configured. Register a model provider plugin before requesting inference.",
		reason: "no-provider" | "capability-disabled" = "no-provider",
	) {
		super(message, {
			code: "NO_MODEL_PROVIDER_CONFIGURED",
			context: { reason },
		});
		this.reason = reason;
	}
}

export const TEXT_GENERATION_MODEL_KEYS: readonly string[] =
	TEXT_GENERATION_MODEL_TYPES;

const TEXT_GENERATION_MODEL_KEY_SET: ReadonlySet<string> = new Set(
	TEXT_GENERATION_MODEL_KEYS,
);

/** Exact (unnormalized) membership test for the built-in text-generation slots. */
export function isTextGenerationModelKey(modelKey: string): boolean {
	return TEXT_GENERATION_MODEL_KEY_SET.has(modelKey);
}

/**
 * The caller-declared stream fields a structured call may release, by field
 * name, with the part kinds that stream when the value is a parts array.
 * A free-string field streams only when the skeleton declares it one; a
 * field with `partKinds` also streams when the skeleton declares any other
 * value shape for it (the extractor walks only a `[{kind, value}]` array).
 */
export function resolveStructuredStreamFields(
	skeleton: ResponseSkeleton | undefined,
	requested: readonly StructuredStreamField[] | undefined,
): { fields: string[]; parts: Record<string, readonly string[]> } {
	const fields: string[] = [];
	const parts: Record<string, readonly string[]> = {};
	if (!skeleton || !requested?.length) {
		return { fields, parts };
	}
	for (const { field, partKinds } of requested) {
		if (fields.includes(field)) continue;
		const span = skeleton.spans.find((entry) => entry.key === field);
		if (!span) continue;
		if (span.kind === "free-string") {
			fields.push(field);
			continue;
		}
		if (partKinds?.length) {
			fields.push(field);
			parts[field] = partKinds;
		}
	}
	return { fields, parts };
}

export function isTextStreamResult(
	value: JsonValue | object,
): value is TextStreamResult {
	return (
		typeof value === "object" &&
		value !== null &&
		"textStream" in value &&
		"text" in value &&
		"usage" in value &&
		"finishReason" in value
	);
}

/** Built-in text slots accept text, a typed text result, or a text stream.
 * Custom model slots retain their own result contracts. */
export function assertModelResultPresent(
	result: unknown,
	modelType: string,
): void {
	if (!isTextGenerationModelKey(modelType)) return;
	if (typeof result === "string") return;
	if (typeof result === "object" && result !== null) {
		if (isTextStreamResult(result)) {
			if (typeof result.textStream?.[Symbol.asyncIterator] === "function")
				return;
		} else if ("text" in result && typeof result.text === "string") return;
	}
	throw new TypeError(`Invalid text result for model type ${modelType}`);
}

export async function assertRuntimeModelOutputComplete(args: {
	result: unknown;
	provider: string;
	model: string;
}): Promise<void> {
	if (typeof args.result !== "object" || args.result === null) return;
	const record = args.result as { finishReason?: unknown };
	if (!("finishReason" in record)) return;
	assertModelOutputComplete({
		finishReason: await Promise.resolve(record.finishReason),
		provider: args.provider,
		model: args.model,
	});
}

/**
 * Read the hidden reasoning-token count from a model response so it can be
 * surfaced on the successful model span. Native results (tool-call
 * shape) carry a `.usage` object; plain-text results do not, and the field is
 * left undefined there. Returns a finite non-negative number or `undefined`;
 * missing is preserved as missing rather than coerced to zero so an
 * unattributed burst stays distinguishable from a confirmed-none call.
 *
 * Covers the elizaOS `TokenUsage.reasoningTokens` field plus the two raw
 * provider shapes the AI SDK exposes (`usage.reasoningTokens` and
 * `providerMetadata.completion_tokens_details.reasoning_tokens`).
 */
export function readReasoningTokensFromResponse(
	response: unknown,
): number | undefined {
	if (typeof response !== "object" || response === null) return undefined;
	const record = response as Record<string, unknown>;
	const usage = isPlainObject(record.usage) ? record.usage : undefined;
	if (usage && typeof usage.reasoningTokens === "number") {
		return finiteNonNegative(usage.reasoningTokens);
	}
	// Fall back to provider metadata when the adapter did not normalize the
	// field into the usage object (some OpenAI-compatible paths expose it only
	// under completion_tokens_details).
	const providerMetadata = isPlainObject(record.providerMetadata)
		? record.providerMetadata
		: undefined;
	const details = !providerMetadata
		? undefined
		: isPlainObject(providerMetadata.completion_tokens_details)
			? providerMetadata.completion_tokens_details
			: isPlainObject(providerMetadata.completionTokensDetails)
				? providerMetadata.completionTokensDetails
				: undefined;
	if (!details) return undefined;
	if (typeof details.reasoning_tokens === "number") {
		return finiteNonNegative(details.reasoning_tokens);
	}
	if (typeof details.reasoningTokens === "number") {
		return finiteNonNegative(details.reasoningTokens);
	}
	return undefined;
}

function finiteNonNegative(value: number): number | undefined {
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export interface ResolvedModelRegistration {
	handler: ModelHandler["handler"];
	metadata?: ModelRegistrationMetadata;
	modelKey: string;
	provider: string;
}

const SLOT_MODEL_SETTINGS: ReadonlyMap<string, string> = new Map([
	["TEXT_NANO", "NANO_MODEL"],
	["TEXT_MINI", "MINI_MODEL"],
	["TEXT_SMALL", "SMALL_MODEL"],
	["TEXT_LARGE", "LARGE_MODEL"],
	["TEXT_MEGA", "MEGA_MODEL"],
	["RESPONSE_HANDLER", "RESPONSE_HANDLER_MODEL"],
	["ACTION_PLANNER", "ACTION_PLANNER_MODEL"],
	["REASONING_SMALL", "REASONING_SMALL_MODEL"],
	["REASONING_LARGE", "REASONING_LARGE_MODEL"],
	["TEXT_COMPLETION", "COMPLETION_MODEL"],
]);
const PROVIDER_MODEL_SETTING_PREFIXES = [
	"OLLAMA_",
	"OPENAI_",
	"ANTHROPIC_",
	"",
];

export function resolveProviderModelString(
	runtime: IAgentRuntime,
	resolvedModelType: string,
	optionsModel?: string,
	effectiveModelId?: string,
): string {
	if (effectiveModelId) return effectiveModelId;
	if (optionsModel) return optionsModel;

	for (const candidate of getModelFallbackChain(
		resolvedModelType as ModelTypeName,
	)) {
		const settingKey = SLOT_MODEL_SETTINGS.get(candidate);
		if (!settingKey) continue;
		for (const prefix of PROVIDER_MODEL_SETTING_PREFIXES) {
			const val = runtime.getSetting(`${prefix}${settingKey}`);
			if (typeof val === "string" && val) return val;
		}
	}

	return resolvedModelType;
}

export const CANONICAL_TEXT_CAPABILITY_SETTING =
	"ELIZA_CANONICAL_LLM_TEXT_ENABLED";
export const CANONICAL_EMBEDDING_CAPABILITY_SETTING =
	"ELIZA_CANONICAL_EMBEDDINGS_ENABLED";

export function isCanonicalModelCapabilityDisabled(
	runtime: Pick<IAgentRuntime, "getSetting">,
	modelType: string,
): boolean {
	const setting = isTextGenerationModelKey(modelType)
		? runtime.getSetting(CANONICAL_TEXT_CAPABILITY_SETTING)
		: modelType === ModelType.TEXT_EMBEDDING
			? runtime.getSetting(CANONICAL_EMBEDDING_CAPABILITY_SETTING)
			: undefined;
	return setting === false || String(setting).trim().toLowerCase() === "false";
}
