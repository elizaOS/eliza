import type { Plugin } from "@elizaos/core";
export declare const shellPlugin: Plugin;
export default shellPlugin;
export { clearHistory } from "./actions/clearHistory";
export { executeCommand } from "./actions/executeCommand";
export { processAction } from "./actions/processAction";
export { shellHistoryProvider } from "./providers/shellHistoryProvider";
export { ShellService } from "./services/shellService";
export {
  addSession,
  appendOutput,
  clearFinished,
  createSessionSlug,
  deleteSession,
  drainSession,
  getFinishedSession,
  getSession,
  listFinishedSessions,
  listRunningSessions,
  markBackgrounded,
  markExited,
  resetProcessRegistryForTests,
  setJobTtlMs,
  tail,
  trimWithCap,
} from "./services/processRegistry";
export type {
  CommandHistoryEntry,
  CommandResult,
  ExecResult,
  ExecuteOptions,
  FileOperation,
  FileOperationType,
  FinishedSession,
  ProcessAction,
  ProcessActionParams,
  ProcessSession,
  ProcessStatus,
  PtyExitEvent,
  PtyHandle,
  PtyListener,
  PtySpawn,
  SessionStdin,
  ShellConfig,
} from "./types";
export {
  DEFAULT_FORBIDDEN_COMMANDS,
  extractBaseCommand,
  isForbiddenCommand,
  isSafeCommand,
  loadShellConfig,
  validatePath,
} from "./utils";
export {
  chunkString,
  clampNumber,
  coerceEnv,
  deriveSessionName,
  formatDuration,
  formatSpawnError,
  getShellConfig,
  killProcessTree,
  killSession,
  pad,
  readEnvInt,
  resolveWorkdir,
  sanitizeBinaryOutput,
  sliceLogLines,
  sliceUtf16Safe,
  spawnWithFallback,
  truncateMiddle,
  type SpawnFallback,
  type SpawnWithFallbackResult,
} from "./utils/shellUtils";
export {
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  buildCursorPositionResponse,
  encodeKeySequence,
  encodePaste,
  stripDsrRequests,
  type KeyEncodingRequest,
  type KeyEncodingResult,
} from "./utils/ptyKeys";
