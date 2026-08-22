/**
 * Bridges the child runtime's completed coding actions onto ACP `tool_call`
 * updates. The orchestrator's write ledger, deterministic verifier, and
 * deliverable capture read only ACP tool events; this runtime executes
 * FILE/SHELL in-process, so without the bridge every tool call was invisible
 * to the parent and the verifier judged prose alone (live 2026-08-21: a script
 * that ran with exit 0 failed verification for "no execution logs", costing a
 * coaching lap on every build).
 */

import type { Content } from "@elizaos/core";

export interface AcpToolCallUpdate {
  sessionId: string;
  update: {
    sessionUpdate: "tool_call";
    toolCallId: string;
    title: string;
    kind: "edit" | "delete" | "execute";
    status: "completed" | "failed";
    rawInput: Record<string, string>;
    rawOutput?: string;
    locations?: Array<{ path: string }>;
  };
}

/** FILE operations that only observe the workspace — never ledger material. */
const FILE_MUTATION_OPERATIONS = new Set([
  "write",
  "edit",
  "create",
  "delete",
  "rm",
  "move",
  "mv",
  "copy",
  "cp",
  "mkdir",
  "touch",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Translate one ACTION_COMPLETED payload into the ACP tool call the
 * orchestrator can verify against. Returns undefined for actions that carry
 * no ledger evidence (reads, listings, non-coding actions, calls without a
 * command or path).
 */
export function toolCallUpdateFromAction(
  sessionId: string,
  content: Content,
  toolCallId: string,
): AcpToolCallUpdate | undefined {
  const name = Array.isArray(content.actions) ? content.actions[0] : undefined;
  const result = record(content.actionResult);
  const data = record(result?.data);
  const output = str(result?.text) ?? str(content.text);
  const status: "completed" | "failed" =
    content.actionStatus === "completed" ? "completed" : "failed";
  if (name === "SHELL") {
    const command = str(data?.command);
    if (!command) return undefined;
    const cwd = str(data?.cwd);
    return {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: `$ ${command}`,
        kind: "execute",
        status,
        rawInput: { command, ...(cwd ? { cwd } : {}) },
        ...(output ? { rawOutput: output } : {}),
      },
    };
  }
  if (name === "FILE") {
    const path = str(data?.path);
    const operation = str(data?.operation)?.toLowerCase();
    if (!path || !operation || !FILE_MUTATION_OPERATIONS.has(operation)) {
      return undefined;
    }
    const kind =
      operation === "delete" || operation === "rm" ? "delete" : "edit";
    return {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: `FILE ${operation ?? "write"} ${path}`,
        kind,
        status,
        rawInput: { path, ...(operation ? { operation } : {}) },
        locations: [{ path }],
        ...(output ? { rawOutput: output } : {}),
      },
    };
  }
  return undefined;
}
