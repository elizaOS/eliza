/**
 * Shell execution module (formerly the standalone @elizaos/plugin-shell):
 * ShellService (command execution, PTY, background sessions), ExecApprovalService
 * (allowlist + approval gating), and the SHELL_HISTORY provider. Registered by
 * codingToolsPlugin in ../index.ts; the SHELL action (../actions/bash.ts)
 * consumes ShellService via runtime.getService("shell").
 */
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
export { ShellService } from "./services/shellService";
export * from "./types";
