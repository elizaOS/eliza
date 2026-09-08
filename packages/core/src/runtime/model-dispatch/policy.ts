/** Defines model registration, admission, and diagnostic policies shared by runtime model dispatch. */
import {
	type JsonValue,
	type ModelHandler,
	type ModelRegistrationMetadata,
	type ResponseSkeleton,
	TEXT_GENERATION_MODEL_TYPES,
	type TextStreamResult,
} from "../../types";
import { assertModelOutputComplete } from "../../utils/model-errors";
import { isPlainObject } from "../../utils/type-guards";

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
export class NoModelProviderConfiguredError extends Error {
	readonly reason: "no-provider" | "capability-disabled";

	constructor(
		message: string = "This agent has no LLM provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY in your environment, or sign in to Eliza Cloud (ELIZAOS_CLOUD_API_KEY).",
		reason: "no-provider" | "capability-disabled" = "no-provider",
	) {
		super(message);
		this.name = "NoModelProviderConfiguredError";
		this.reason = reason;
	}
}

export const TEXT_GENERATION_MODEL_KEYS: readonly string[] =
	TEXT_GENERATION_MODEL_TYPES;

export const DEFAULT_RESPONSE_SKELETON_STREAM_FIELDS = new Set([
	"text",
	"messageToUser",
]);

export function resolveResponseSkeletonStreamFields(
	skeleton: ResponseSkeleton | undefined,
): string[] {
	if (!skeleton) {
		return [];
	}
	const fields: string[] = [];
	const seen = new Set<string>();
	for (const span of skeleton.spans) {
		const key = span.key;
		if (
			span.kind === "free-string" &&
			key &&
			DEFAULT_RESPONSE_SKELETON_STREAM_FIELDS.has(key) &&
			!seen.has(key)
		) {
			seen.add(key);
			fields.push(key);
		}
	}
	return fields;
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
 * surfaced on the successful model span (#16394). Native results (tool-call
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
	const usageRaw = isPlainObject(record.usage) ? record.usage : undefined;
	const usage = usageRaw as Record<string, unknown> | undefined;
	const fromUsage =
		usage && typeof usage.reasoningTokens === "number"
			? usage.reasoningTokens
			: undefined;
	if (fromUsage !== undefined) {
		return Number.isFinite(fromUsage) && fromUsage >= 0 ? fromUsage : undefined;
	}
	// Fall back to provider metadata when the adapter did not normalize the
	// field into the usage object (some OpenAI-compatible paths expose it only
	// under completion_tokens_details).
	const providerMetadataRaw = isPlainObject(record.providerMetadata)
		? record.providerMetadata
		: undefined;
	const providerMetadata = providerMetadataRaw as
		| Record<string, unknown>
		| undefined;
	const detailsRaw = providerMetadata
		? isPlainObject(providerMetadata.completion_tokens_details)
			? providerMetadata.completion_tokens_details
			: isPlainObject(providerMetadata.completionTokensDetails)
				? providerMetadata.completionTokensDetails
				: undefined
		: undefined;
	const details = detailsRaw as Record<string, unknown> | undefined;
	const fromDetails = details
		? typeof details.reasoning_tokens === "number"
			? details.reasoning_tokens
			: typeof details.reasoningTokens === "number"
				? details.reasoningTokens
				: undefined
		: undefined;
	if (fromDetails !== undefined) {
		return Number.isFinite(fromDetails) && fromDetails >= 0
			? fromDetails
			: undefined;
	}
	return undefined;
}

export interface ResolvedModelRegistration {
	handler: ModelHandler["handler"];
	metadata?: ModelRegistrationMetadata;
	modelKey: string;
	provider: string;
}
