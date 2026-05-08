import type { ActionResult, UUID } from "@elizaos/core";

export const CODING_TOOLS_LOG_PREFIX = "[CodingTools]";

export const FILE_STATE_SERVICE = "CODING_TOOLS_FILE_STATE";
export const SANDBOX_SERVICE = "CODING_TOOLS_SANDBOX";
export const SESSION_CWD_SERVICE = "CODING_TOOLS_SESSION_CWD";
export const RIPGREP_SERVICE = "CODING_TOOLS_RIPGREP";

export const CODING_TOOLS_CONTEXTS = ["code", "terminal", "automation"] as const;
export type CodingToolsContext = (typeof CODING_TOOLS_CONTEXTS)[number];

export interface FileMeta {
  path: string;
  mtimeMs: number;
  size: number;
  readAt: number;
}

export type ToolFailureReason =
  | "disabled"
  | "missing_param"
  | "invalid_param"
  | "path_blocked"
  | "stale_read"
  | "no_match"
  | "unchanged"
  | "command_failed"
  | "timeout"
  | "io_error"
  | "internal";

export interface ToolFailure {
  reason: ToolFailureReason;
  message: string;
}

export type ToolResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: ToolFailure };

export interface SessionKey {
  conversationId: string;
  agentId: UUID;
}

export type ActionResultData = NonNullable<ActionResult["data"]>;

export const FAILURE_TEXT_PREFIX = "[CodingTools]";

export function failure<T>(reason: ToolFailureReason, message: string): ToolResult<T> {
  return { ok: false, failure: { reason, message } };
}

export function success<T>(value: T): ToolResult<T> {
  return { ok: true, value };
}
