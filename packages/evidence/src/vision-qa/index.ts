/** Public surface of the vision-qa VLM screenshot Q&A layer (#14544). */

export { askAboutImage, askBatch } from "./ask.ts";
export {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_VERSION,
  AnthropicBackend,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_LOCAL_MODEL,
  DEFAULT_OPENAI_MODEL,
  OpenAiCompatibleBackend,
  parseAnswers,
  renderQuestionPrompt,
  SYSTEM_RUBRIC,
  type BackendRequest,
  type BackendResponse,
  type VisionBackendClient,
} from "./backends.ts";
export {
  CACHE_DIR_NAME,
  cacheFilePath,
  queryHash,
  readCache,
  writeCache,
} from "./cache.ts";
export {
  createBackendClient,
  ENV as VISION_QA_ENV,
  resolveBackend,
} from "./config.ts";
export { runVisionQaCli, type VisionQaCliIo } from "./cli.ts";
export {
  DEFAULT_MAX_EDGE,
  prepareImage,
  type PreparedImage,
  scaleToMaxEdge,
} from "./image.ts";
export {
  buildQaRecord,
  type QaRecord,
  writeQaRecord,
} from "./qa-record.ts";
export {
  type AnalysisInput,
  suggestQuestions,
  type SuggestContext,
} from "./suggest.ts";
export type {
  AskOptions,
  AskResult,
  BatchEntry,
  BatchResult,
  ImageDimensions,
  TokenUsage,
  VisionAnswer,
  VisionBackend,
  VisionProvenance,
  VisionQuestion,
} from "./types.ts";
