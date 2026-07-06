/** Public surface of the vision-qa VLM screenshot Q&A layer (#14544). */

export { askAboutImage, askBatch } from "./ask.ts";
export {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_VERSION,
  AnthropicBackend,
  type BackendRequest,
  type BackendResponse,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_LOCAL_MODEL,
  DEFAULT_OPENAI_MODEL,
  OpenAiCompatibleBackend,
  parseAnswers,
  renderQuestionPrompt,
  SYSTEM_RUBRIC,
  type VisionBackendClient,
} from "./backends.ts";
export {
  CACHE_DIR_NAME,
  cacheFilePath,
  queryHash,
  readCache,
  writeCache,
} from "./cache.ts";
export { runVisionQaCli, type VisionQaCliIo } from "./cli.ts";
export {
  createBackendClient,
  ENV as VISION_QA_ENV,
  resolveBackend,
} from "./config.ts";
export {
  DEFAULT_MAX_EDGE,
  type PreparedImage,
  prepareImage,
  scaleToMaxEdge,
} from "./image.ts";
export {
  buildQaRecord,
  type QaRecord,
  writeQaRecord,
} from "./qa-record.ts";
export {
  type AnalysisInput,
  type SuggestContext,
  suggestQuestions,
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
