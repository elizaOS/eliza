/**
 * Utility functions for ElizaOS.
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
