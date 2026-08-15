/** Exposes the Cloud model handlers and compatibility errors used by callers. */
import { handleResearch as retiredHandleResearch } from "./research";

export type { BatchEmbeddingResult } from "./embeddings";
export { handleBatchTextEmbedding, handleTextEmbedding } from "./embeddings";
export { handleImageDescription, handleImageGeneration } from "./image";
export { handleAudioGeneration, handleVideoGeneration } from "./media";
export { fetchTextToSpeech, handleTextToSpeech } from "./speech";
export {
  handleActionPlanner,
  handleResponseHandler,
  handleTextLarge,
  handleTextMedium,
  handleTextMega,
  handleTextNano,
  handleTextSmall,
} from "./text";
export { handleTokenizerDecode, handleTokenizerEncode } from "./tokenization";
export {
  CloudSttUnavailableError,
  type CloudTranscriptionInput,
  handleTranscription,
} from "./transcription";

/**
 * @deprecated Eliza Cloud research was retired. Install a provider that
 * registers `ModelType.RESEARCH` and call it through `runtime.useModel`.
 */
export const handleResearch = retiredHandleResearch;
