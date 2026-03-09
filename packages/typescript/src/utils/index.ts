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

export { type BooleanParseOptions, parseBooleanValue } from "./boolean.js";

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

export { formatRelativeTime } from "./time-format.js";

export {
  type BannerColors,
  type BannerOptions,
  type PluginSetting,
  displayWidth,
  lineToWidth,
  maskSecret,
  padToWidth,
  printBanner,
  renderBanner,
  sliceByWidth,
  stripAnsi,
} from "./plugin-banner.js";

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

export { deferStartupWork } from "./defer-startup-work.js";

export { extractAndParseJSONObjectFromText } from "./json-llm.js";

export {
  type ConfigSettingValue,
  type LoadPluginConfigOptions,
  type SettingSourceOptions,
  collectSettings,
  formatConfigErrors,
  getBooleanSetting,
  getCsvSetting,
  getEnumSetting,
  getNumberSetting,
  getStringSetting,
  loadPluginConfig,
  resolveSettingRaw,
} from "./plugin-config.js";

export { sliceToFitBudget } from "./slice-to-fit-budget.js";

export {
  cosineSimilarity,
  levenshteinDistance,
  similarityRatio,
  tokenize,
  wordOverlapSimilarity,
} from "./text-similarity.js";
