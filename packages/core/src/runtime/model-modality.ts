/**
 * The single modality classification for built-in model slots. Dispatch
 * decisions that depend on what a slot sends or returns (secret/PII
 * substitution, LLM-mode overrides, processing-policy admission) read these
 * sets instead of maintaining their own lists.
 */
import { ModelType } from "../types/model.js";

export type ProcessingModality =
	| "text"
	| "embedding"
	| "image"
	| "image_description"
	| "transcription"
	| "speech"
	| "audio"
	| "video"
	| "pii_scrub"
	| "tokenizer"
	| "research";

type BuiltInModelTypeValue = (typeof ModelType)[keyof typeof ModelType];

const MODEL_TYPE_MODALITY = {
	[ModelType.TEXT_NANO]: "text",
	[ModelType.TEXT_SMALL]: "text",
	[ModelType.TEXT_MEDIUM]: "text",
	[ModelType.TEXT_LARGE]: "text",
	[ModelType.TEXT_MEGA]: "text",
	[ModelType.RESPONSE_HANDLER]: "text",
	[ModelType.ACTION_PLANNER]: "text",
	[ModelType.TEXT_REASONING_SMALL]: "text",
	[ModelType.TEXT_REASONING_LARGE]: "text",
	[ModelType.TEXT_COMPLETION]: "text",
	[ModelType.TEXT_EMBEDDING]: "embedding",
	[ModelType.TEXT_EMBEDDING_BATCH]: "embedding",
	[ModelType.PII_SCRUB]: "pii_scrub",
	[ModelType.TEXT_TOKENIZER_ENCODE]: "tokenizer",
	[ModelType.TEXT_TOKENIZER_DECODE]: "tokenizer",
	[ModelType.IMAGE]: "image",
	[ModelType.IMAGE_DESCRIPTION]: "image_description",
	[ModelType.TRANSCRIPTION]: "transcription",
	[ModelType.TEXT_TO_SPEECH]: "speech",
	[ModelType.AUDIO]: "audio",
	[ModelType.VIDEO]: "video",
	[ModelType.RESEARCH]: "research",
} as const satisfies Record<BuiltInModelTypeValue, ProcessingModality>;

/** Modality of a built-in model slot; `undefined` for a custom slot. */
export function modalityForModelType(
	modelType: string,
): ProcessingModality | undefined {
	return Object.hasOwn(MODEL_TYPE_MODALITY, modelType)
		? MODEL_TYPE_MODALITY[modelType as BuiltInModelTypeValue]
		: undefined;
}

/**
 * Slots whose primary input is binary media. Secret substitution skips them:
 * there is no text graph to substitute.
 */
export const SECRET_SWAP_SKIP_MODEL_TYPES: ReadonlySet<string> = new Set([
	ModelType.TRANSCRIPTION,
	ModelType.IMAGE,
	ModelType.AUDIO,
	ModelType.VIDEO,
]);

/**
 * Slots the PII pseudonymizer must not touch:
 * - binary-input modalities (nothing to swap);
 * - embeddings, single and batch: a per-turn surrogate would embed the same
 * real text differently every turn and break semantic retrieval;
 * - text-to-speech: the audio would speak the surrogate and cannot be restored;
 * - PII_SCRUB: the scrub classifier must judge the real text it is scrubbing.
 * IMAGE is swapped on purpose: its text prompt can carry real names.
 */
export const PII_SWAP_SKIP_MODEL_TYPES: ReadonlySet<string> = new Set([
	ModelType.TRANSCRIPTION,
	ModelType.AUDIO,
	ModelType.VIDEO,
	ModelType.TEXT_EMBEDDING,
	ModelType.TEXT_EMBEDDING_BATCH,
	ModelType.TEXT_TO_SPEECH,
	ModelType.PII_SCRUB,
]);

/**
 * Text slots the runtime `llmMode` (SMALL/LARGE) override rewrites. Reasoning
 * slots are deliberately excluded so a cost override never replaces an
 * explicitly requested reasoning model.
 */
export const LLM_MODE_OVERRIDE_MODEL_TYPES: ReadonlySet<string> = new Set([
	ModelType.TEXT_NANO,
	ModelType.TEXT_SMALL,
	ModelType.TEXT_MEDIUM,
	ModelType.TEXT_LARGE,
	ModelType.TEXT_MEGA,
	ModelType.RESPONSE_HANDLER,
	ModelType.ACTION_PLANNER,
	ModelType.TEXT_COMPLETION,
]);
