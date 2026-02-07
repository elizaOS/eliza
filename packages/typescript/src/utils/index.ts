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
