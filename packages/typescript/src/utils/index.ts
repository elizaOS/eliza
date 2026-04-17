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
export type { SchemaValueSpec, SchemaValueType } from "../types/state.js";
export {
	type BinariesCheckResult,
	type BinaryDetectResult,
	detectApt,
	detectBinaries,
	detectBinary,
	detectBinaryWithVersion,
	detectBinaryWithWhich,
	detectCargo,
	detectHomebrew,
	detectNodePackageManagers,
	detectPip,
	detectPlatform,
	getMissingBinaries,
	getPathDirs,
	getPreferredNodeManager,
	getStandardBinaryPaths,
	hasAllBinaries,
	isDarwin,
	isLinux,
	isWindows,
	type PackageManagerInfo,
	type Platform,
} from "./binary-detect.js";
export {
	type BooleanParseOptions,
	parseBooleanText,
	parseBooleanValue,
} from "./boolean.js";
export { deferStartupWork } from "./defer-startup-work.js";
export { extractAndParseJSONObjectFromText } from "./json-llm.js";
export {
	type BannerColors,
	type BannerOptions,
	displayWidth,
	lineToWidth,
	maskSecret,
	type PluginSetting,
	padToWidth,
	printBanner,
	renderBanner,
	sliceByWidth,
	stripAnsi,
} from "./plugin-banner.js";
export {
	type ConfigSettingValue,
	collectSettings,
	formatConfigErrors,
	getBooleanSetting,
	getCsvSetting,
	getEnumSetting,
	getNumberSetting,
	getStringSetting,
	type LoadPluginConfigOptions,
	loadPluginConfig,
	resolveSettingRaw,
	type SettingSourceOptions,
} from "./plugin-config.js";
export {
	PromptBatcher,
	PromptDispatcher,
	pickFields,
} from "./prompt-batcher.js";
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
export { sliceToFitBudget } from "./slice-to-fit-budget.js";
export { flattenTextValues, toMultilineText } from "./text-normalize.js";
export {
	cosineSimilarity,
	levenshteinDistance,
	similarityRatio,
	tokenize,
	wordOverlapSimilarity,
} from "./text-similarity.js";
export { formatRelativeTime, formatTimestamp } from "./time-format.js";
export { UnionFind } from "./union-find.js";
