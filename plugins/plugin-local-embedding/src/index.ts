import { localInferencePlugin } from "@elizaos/plugin-local-inference";

export {
  createLocalInferenceModelHandlers,
  isLocalInferenceUnavailableError,
  LOCAL_INFERENCE_MODEL_TYPES,
  LOCAL_INFERENCE_PRIORITY,
  LOCAL_INFERENCE_PROVIDER_ID,
  LOCAL_INFERENCE_TEXT_MODEL_TYPES,
  LocalInferenceUnavailableError,
  type LocalInferenceUnavailableReason,
} from "@elizaos/plugin-local-inference";

/**
 * Deprecated compatibility export.
 *
 * Local embeddings are now one capability of the unified Eliza-1 local
 * inference provider. Keeping this alias lets existing character/plugin
 * configs that still import `@elizaos/plugin-local-embedding` register the
 * same provider instead of creating a second local embedding choice.
 */
export const localEmbeddingPlugin = localInferencePlugin;

/** Legacy alias for older imports from the previous local embedding package. */
export const localAiPlugin = localInferencePlugin;

export default localInferencePlugin;
