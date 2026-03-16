/**
 * Shell Utilities - Platform-specific shell configuration and helpers
 * Ported from otto shell-utils.ts and bash-tools.shared.ts
 */
import { spawn } from "node:child_process";
import type {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  SpawnOptions,
} from "node:child_process";
/**
 * Get shell configuration for the current platform
 */
export declare function getShellConfig(): {
  shell: string;
  args: string[];
};
/**
 * Sanitize binary output by removing control characters
 */
export declare function sanitizeBinaryOutput(text: string): string;
/**
 * Kill a process tree (cross-platform)
 */
export declare function killProcessTree(pid: number): void;
/**
 * Kill a session's process
 */
export declare function killSession(session: {
  pid?: number;
  child?: ChildProcessWithoutNullStreams;
}): void;
/**
 * Coerce environment object to Record<string, string>
 */
export declare function coerceEnv(
  env?: NodeJS.ProcessEnv | Record<string, string>
): Record<string, string>;
/**
 * Resolve working directory with fallback
 */
export declare function resolveWorkdir(workdir: string, warnings: string[]): string;
/**
 * Clamp a number to a range with a default value
 */
export declare function clampNumber(
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number
): number;
/**
 * Read an environment variable as an integer
 */
export declare function readEnvInt(key: string): number | undefined;
/**
 * Chunk a string into smaller pieces
 */
export declare function chunkString(input: string, limit?: number): string[];
/**
 * Safely slice a string respecting UTF-16 surrogate pairs
 */
export declare function sliceUtf16Safe(str: string, start: number, end?: number): string;
/**
 * Truncate string in the middle with ellipsis
 */
export declare function truncateMiddle(str: string, max: number): string;
/**
 * Slice log lines with optional offset and limit
 */
export declare function sliceLogLines(
  text: string,
  offset?: number,
  limit?: number
): {
  slice: string;
  totalLines: number;
  totalChars: number;
};
/**
 * Derive a session name from a command
 */
export declare function deriveSessionName(command: string): string | undefined;
/**
 * Format duration in human-readable format
 */
export declare function formatDuration(ms: number): string;
/**
 * Pad a string to a minimum width
 */
export declare function pad(str: string, width: number): string;
export type SpawnFallback = {
  label: string;
  options: SpawnOptions;
};
export type SpawnWithFallbackResult = {
  child: ChildProcess;
  usedFallback: boolean;
  fallbackLabel?: string;
};
type SpawnWithFallbackParams = {
  argv: string[];
  options: SpawnOptions;
  fallbacks?: SpawnFallback[];
  spawnImpl?: typeof spawn;
  retryCodes?: string[];
  onFallback?: (err: unknown, fallback: SpawnFallback) => void;
};
/**
 * Format a spawn error for display
 */
export declare function formatSpawnError(err: unknown): string;
/**
 * Spawn a process with fallback options on certain error codes
 */
export declare function spawnWithFallback(
  params: SpawnWithFallbackParams
): Promise<SpawnWithFallbackResult>;
