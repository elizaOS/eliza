/**
 * Utility functions for elizaOS.
 *
 * Provides various utility functions including:
 * - Retry logic with exponential backoff
 * - Boolean parsing
 * - Time formatting
 *
 * Note: Process execution utilities are in @elizaos/plugin-shell
 *
 * @module utils
 */

export {
  type BooleanParseOptions,
  parseBooleanText,
  parseBooleanValue,
} from "./boolean.js";

export {
  type BackoffPolicy,
  computeBackoff,
  type RetryConfig,
  type RetryInfo,
  type RetryOptions,
  resolveRetryConfig,
  retryAsync,
  sleep,
  sleepWithAbort,
} from "./retry.js";

export { formatRelativeTime, formatTimestamp } from "./time-format.js";

export { flattenTextValues, toMultilineText } from "./text-normalize.js";

export {
  pickFields,
  PromptBatcher,
  PromptDispatcher,
} from "./prompt-batcher.js";

export {
  BatcherDisposedError,
  type BatcherStats,
  type ContextResolver,
  type DrainLog,
  type DrainMeta,
  type PreCallbackHandler,
  type PromptSection,
  type ResolvedSection,
  type SectionFrequency,
} from "../types/prompt-batcher.js";

export { type SchemaValueSpec, type SchemaValueType } from "../types/state.js";

export {
  type BinaryDetectResult,
  type BinariesCheckResult,
  type Platform,
  type PackageManagerInfo,
  detectPlatform,
  isWindows,
  isDarwin,
  isLinux,
  getPathDirs,
  getStandardBinaryPaths,
  detectBinary,
  detectBinaryWithWhich,
  detectBinaries,
  getMissingBinaries,
  hasAllBinaries,
  detectBinaryWithVersion,
  detectNodePackageManagers,
  getPreferredNodeManager,
  detectHomebrew,
  detectApt,
  detectPip,
  detectCargo,
} from "./binary-detect.js";
