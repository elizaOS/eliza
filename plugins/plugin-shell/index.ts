import type { Plugin } from "@elizaos/core";
import { shellHistoryAction } from "./actions";
import { ExecApprovalService } from "./approvals";
import { shellHistoryProvider } from "./providers";
import { ShellService } from "./services/shellService";

export const shellPlugin: Plugin = {
  name: "shell",
  description: "Shell observability and history management providers",
  services: [ShellService, ExecApprovalService],
  actions: [shellHistoryAction],
  providers: [shellHistoryProvider],
  // Self-declared auto-enable: activate when features.shell is enabled.
  autoEnable: {
    shouldEnable: (_env, config) => {
      const f = (config?.features as Record<string, unknown> | undefined)?.shell;
      return (
        f === true ||
        (typeof f === "object" && f !== null && (f as { enabled?: unknown }).enabled !== false)
      );
    },
  },
};

export default shellPlugin;

// Actions
export { clearHistory, shellHistoryAction } from "./actions/shellHistory";

// Approvals
export {
  addAllowlistEntry,
  analyzeShellCommand,
  type CommandCheckResult,
  type CommandResolution,
  DEFAULT_SAFE_BINS,
  EXEC_APPROVAL_DEFAULTS,
  type ExecAllowlistAnalysis,
  type ExecAllowlistEntry,
  type ExecAllowlistEvaluation,
  type ExecApprovalDecision,
  type ExecApprovalRequest,
  type ExecApprovalResult,
  ExecApprovalService,
  type ExecApprovalsAgent,
  type ExecApprovalsDefaults,
  type ExecApprovalsFile,
  type ExecApprovalsResolved,
  type ExecApprovalsSnapshot,
  type ExecAsk,
  type ExecCommandAnalysis,
  type ExecCommandSegment,
  type ExecHost,
  type ExecSecurity,
  ensureApprovals,
  evaluateExecAllowlist,
  evaluateShellAllowlist,
  getApprovalFilePath,
  getApprovalSocketPath,
  isSafeBinUsage,
  loadApprovals,
  matchAllowlist,
  maxAsk,
  minSecurity,
  normalizeApprovals,
  normalizeSafeBins,
  readApprovalsSnapshot,
  recordAllowlistUse,
  requiresExecApproval,
  resolveApprovals,
  resolveApprovalsFromFile,
  resolveCommandFromArgv,
  resolveCommandResolution,
  resolveSafeBins,
  saveApprovals,
} from "./approvals";
export { shellHistoryProvider } from "./providers/shellHistoryProvider";
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
// Services
export { ShellService } from "./services/shellService";

// Types
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

// Utilities
export {
  DEFAULT_FORBIDDEN_COMMANDS,
  extractBaseCommand,
  isForbiddenCommand,
  isSafeCommand,
  loadShellConfig,
  validatePath,
} from "./utils";
export {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  buildCursorPositionResponse,
  encodeKeySequence,
  encodePaste,
  type KeyEncodingRequest,
  type KeyEncodingResult,
  stripDsrRequests,
} from "./utils/ptyKeys";
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
  type SpawnFallback,
  type SpawnWithFallbackResult,
  sanitizeBinaryOutput,
  sliceLogLines,
  sliceUtf16Safe,
  spawnWithFallback,
  truncateMiddle,
} from "./utils/shellUtils";
