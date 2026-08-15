/**
 * Resolves the host-declared canonical model capability surface. Hosts that
 * omit embeddings or text generation use these settings to prevent both model
 * registration and speculative work from claiming an unavailable capability.
 */

import { ModelType, TEXT_GENERATION_MODEL_TYPES } from "../types/model.ts";
import type { IAgentRuntime } from "../types/runtime.ts";

export const CANONICAL_TEXT_CAPABILITY_SETTING =
	"ELIZA_CANONICAL_LLM_TEXT_ENABLED";
export const CANONICAL_EMBEDDING_CAPABILITY_SETTING =
	"ELIZA_CANONICAL_EMBEDDINGS_ENABLED";

const TEXT_GENERATION_MODEL_KEYS: ReadonlySet<string> = new Set(
	TEXT_GENERATION_MODEL_TYPES,
);

export function isCanonicalModelCapabilityDisabled(
	runtime: Pick<IAgentRuntime, "getSetting">,
	modelType: string,
): boolean {
	const setting = TEXT_GENERATION_MODEL_KEYS.has(modelType)
		? runtime.getSetting(CANONICAL_TEXT_CAPABILITY_SETTING)
		: modelType === ModelType.TEXT_EMBEDDING
			? runtime.getSetting(CANONICAL_EMBEDDING_CAPABILITY_SETTING)
			: undefined;
	return setting === false || String(setting).trim().toLowerCase() === "false";
}
