/**
 * Exec Approvals Module
 *
 * Command execution approval system for plugin-shell.
 * Provides allowlist management, command analysis, and approval workflows.
 */

// Allowlist management
export {
  addAllowlistEntry,
  ensureApprovals,
  getApprovalFilePath,
  getApprovalSocketPath,
  loadApprovals,
  matchAllowlist,
  maxAsk,
  minSecurity,
  normalizeApprovals,
  readApprovalsSnapshot,
  recordAllowlistUse,
  resolveApprovals,
  resolveApprovalsFromFile,
  saveApprovals,
} from "./allowlist";
// Command analysis
export {
  analyzeShellCommand,
  evaluateExecAllowlist,
  evaluateShellAllowlist,
  isSafeBinUsage,
  normalizeSafeBins,
  requiresExecApproval,
  resolveCommandFromArgv,
  resolveCommandResolution,
  resolveSafeBins,
} from "./analysis";
// Service
export { type CommandCheckResult, ExecApprovalService } from "./service";
// Types
export type {
  CommandResolution,
  ExecAllowlistAnalysis,
  ExecAllowlistEntry,
  ExecAllowlistEvaluation,
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalResult,
  ExecApprovalsAgent,
  ExecApprovalsDefaults,
  ExecApprovalsFile,
  ExecApprovalsResolved,
  ExecApprovalsSnapshot,
  ExecAsk,
  ExecCommandAnalysis,
  ExecCommandSegment,
  ExecHost,
  ExecSecurity,
} from "./types";
export { DEFAULT_SAFE_BINS, EXEC_APPROVAL_DEFAULTS } from "./types";
