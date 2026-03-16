/**
 * Lobster workflow runtime types
 */

export interface LobsterRunParams {
  /** The pipeline to execute */
  pipeline: string;
  /** JSON string of arguments to pass to the pipeline */
  argsJson?: string;
  /** Working directory (relative, must stay within gateway working directory) */
  cwd?: string;
  /** Timeout in milliseconds (default: 20000) */
  timeoutMs?: number;
  /** Maximum stdout bytes (default: 512000) */
  maxStdoutBytes?: number;
}

export interface LobsterResumeParams {
  /** Resume token from a previous needs_approval response */
  token: string;
  /** Whether to approve the pending action */
  approve: boolean;
  /** Working directory (relative) */
  cwd?: string;
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Maximum stdout bytes */
  maxStdoutBytes?: number;
}

export interface LobsterApprovalRequest {
  type: "approval_request";
  prompt: string;
  items: unknown[];
  resumeToken?: string;
}

export interface LobsterSuccessEnvelope {
  ok: true;
  status: "ok" | "needs_approval" | "cancelled";
  output: unknown[];
  requiresApproval: LobsterApprovalRequest | null;
}

export interface LobsterErrorEnvelope {
  ok: false;
  error: {
    type?: string;
    message: string;
  };
}

export type LobsterEnvelope = LobsterSuccessEnvelope | LobsterErrorEnvelope;

export interface LobsterConfig {
  /** Path to the lobster executable (default: "lobster" from PATH) */
  lobsterPath?: string;
  /** Default timeout in milliseconds */
  defaultTimeoutMs?: number;
  /** Default max stdout bytes */
  defaultMaxStdoutBytes?: number;
}
