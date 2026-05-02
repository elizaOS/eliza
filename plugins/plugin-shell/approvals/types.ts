/**
 * Exec Approval Types
 *
 * Types for command execution approval system in plugin-shell.
 * Provides type definitions for approval configuration, allowlist entries,
 * command analysis, and approval decisions.
 */

import type { UUID } from "@elizaos/core";

/**
 * Security levels for command execution
 */
export type ExecSecurity = "deny" | "allowlist" | "full";

/**
 * Ask modes for approval prompts
 */
export type ExecAsk = "off" | "on-miss" | "always";

/**
 * Execution host types
 */
export type ExecHost = "sandbox" | "gateway" | "node";

/**
 * Default configuration for exec approvals
 */
export interface ExecApprovalsDefaults {
  /** Security level (deny, allowlist, full) */
  security?: ExecSecurity;
  /** Ask mode (off, on-miss, always) */
  ask?: ExecAsk;
  /** Fallback security when ask is declined */
  askFallback?: ExecSecurity;
  /** Auto-allow commands from skill definitions */
  autoAllowSkills?: boolean;
}

/**
 * Allowlist entry for permitted commands
 */
export interface ExecAllowlistEntry {
  /** Unique identifier */
  id?: string;
  /** Pattern to match (executable path or glob) */
  pattern: string;
  /** Last time this pattern was used */
  lastUsedAt?: number;
  /** Last command that matched this pattern */
  lastUsedCommand?: string;
  /** Last resolved executable path */
  lastResolvedPath?: string;
}

/**
 * Agent-specific approval configuration
 */
export interface ExecApprovalsAgent extends ExecApprovalsDefaults {
  /** Allowlist entries for this agent */
  allowlist?: ExecAllowlistEntry[];
}

/**
 * Full approval configuration file structure
 */
export interface ExecApprovalsFile {
  /** Version number (always 1) */
  version: 1;
  /** Socket configuration for external approval UI */
  socket?: {
    path?: string;
    token?: string;
  };
  /** Default approval settings */
  defaults?: ExecApprovalsDefaults;
  /** Per-agent approval settings */
  agents?: Record<string, ExecApprovalsAgent>;
}

/**
 * Snapshot of approval configuration file
 */
export interface ExecApprovalsSnapshot {
  /** File path */
  path: string;
  /** Whether the file exists */
  exists: boolean;
  /** Raw file content */
  raw: string | null;
  /** Parsed and normalized configuration */
  file: ExecApprovalsFile;
  /** Content hash */
  hash: string;
}

/**
 * Resolved approval configuration for an agent
 */
export interface ExecApprovalsResolved {
  /** File path */
  path: string;
  /** Socket path for external approval UI */
  socketPath: string;
  /** Authentication token */
  token: string;
  /** Resolved default settings */
  defaults: Required<ExecApprovalsDefaults>;
  /** Resolved agent-specific settings */
  agent: Required<ExecApprovalsDefaults>;
  /** Combined allowlist entries */
  allowlist: ExecAllowlistEntry[];
  /** Full configuration file */
  file: ExecApprovalsFile;
}

/**
 * Command resolution result
 */
export interface CommandResolution {
  /** The raw executable from the command */
  rawExecutable: string;
  /** Fully resolved executable path */
  resolvedPath?: string;
  /** Executable name (basename) */
  executableName: string;
}

/**
 * Command segment from shell parsing
 */
export interface ExecCommandSegment {
  /** Raw command text */
  raw: string;
  /** Parsed argument vector */
  argv: string[];
  /** Resolution of the executable */
  resolution: CommandResolution | null;
}

/**
 * Result of command analysis
 */
export interface ExecCommandAnalysis {
  /** Whether analysis succeeded */
  ok: boolean;
  /** Reason for failure (if any) */
  reason?: string;
  /** Parsed command segments */
  segments: ExecCommandSegment[];
  /** Segments grouped by chain operators (&&, ||, ;) */
  chains?: ExecCommandSegment[][];
}

/**
 * Result of allowlist evaluation
 */
export interface ExecAllowlistEvaluation {
  /** Whether all commands are in the allowlist */
  allowlistSatisfied: boolean;
  /** Matching allowlist entries */
  allowlistMatches: ExecAllowlistEntry[];
}

/**
 * Combined analysis and allowlist evaluation
 */
export interface ExecAllowlistAnalysis {
  /** Whether analysis succeeded */
  analysisOk: boolean;
  /** Whether allowlist is satisfied */
  allowlistSatisfied: boolean;
  /** Matching allowlist entries */
  allowlistMatches: ExecAllowlistEntry[];
  /** Parsed command segments */
  segments: ExecCommandSegment[];
}

/**
 * Possible approval decisions
 */
export type ExecApprovalDecision = "allow-once" | "allow-always" | "deny";

/**
 * Request for exec approval
 */
export interface ExecApprovalRequest {
  /** Unique request ID */
  id: string;
  /** The command to execute */
  command: string;
  /** Working directory */
  cwd?: string;
  /** Execution host */
  host?: ExecHost;
  /** Security level */
  security?: ExecSecurity;
  /** Ask mode */
  ask?: ExecAsk;
  /** Agent ID */
  agentId?: string;
  /** Resolved executable path */
  resolvedPath?: string;
  /** Session key for routing */
  sessionKey?: string;
  /** Room ID where approval is requested */
  roomId: UUID;
  /** Timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Result of exec approval
 */
export interface ExecApprovalResult {
  /** The decision made */
  decision: ExecApprovalDecision;
  /** Whether approval timed out */
  timedOut: boolean;
  /** Who resolved the approval */
  resolvedBy?: UUID;
}

/**
 * Configuration for safe binary commands that don't need approval
 */
export const DEFAULT_SAFE_BINS = [
  "jq",
  "grep",
  "cut",
  "sort",
  "uniq",
  "head",
  "tail",
  "tr",
  "wc",
] as const;

/**
 * Default exec approval settings
 */
export const EXEC_APPROVAL_DEFAULTS = {
  security: "deny" as ExecSecurity,
  ask: "on-miss" as ExecAsk,
  askFallback: "deny" as ExecSecurity,
  autoAllowSkills: false,
  timeoutMs: 120_000,
} as const;
