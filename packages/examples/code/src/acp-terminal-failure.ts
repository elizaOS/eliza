/**
 * Converts the coding runtime's typed failed-turn exception into the ACP
 * prompt-result extension consumed by the parent orchestrator.
 */
import { ElizaError } from "@elizaos/core";

export interface AcpTerminalFailureReceipt {
  kind: string;
  code?: string;
  transient: boolean;
  message: string;
}

/** Preserve only the dedicated failed-turn exception; unrelated faults throw. */
export function terminalFailureFromAgentClientError(
  error: unknown,
): AcpTerminalFailureReceipt | undefined {
  if (
    !(error instanceof ElizaError) ||
    error.code !== "ELIZA_CODE_SYNTHETIC_TURN_FAILURE"
  ) {
    return undefined;
  }
  const context = error.context;
  if (!context) return undefined;
  const kind =
    typeof context.failureKind === "string" && context.failureKind.trim()
      ? context.failureKind.trim()
      : undefined;
  if (!kind || typeof context.transient !== "boolean") return undefined;
  const code =
    typeof context.failureCode === "string" && context.failureCode.trim()
      ? context.failureCode.trim()
      : undefined;
  return {
    kind,
    ...(code ? { code } : {}),
    transient: context.transient,
    message: error.message,
  };
}
