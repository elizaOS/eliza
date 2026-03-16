/**
 * PTY session hydration — maps server task data to CodingAgentSession objects.
 *
 * Migrated from apps/app/src/pty-session-hydrate.ts.
 */

import type { CodingAgentSession } from "../api/client";

/** Statuses that represent a finished session — excluded from hydration. */
export const TERMINAL_STATUSES = new Set(["completed", "stopped", "error"]);

/** Shape of a task object returned by the /api/coding-agents/status endpoint. */
export interface ServerTask {
  sessionId: string;
  agentType?: string;
  label?: string;
  originalTask?: string;
  workdir?: string;
  status?: string;
  decisionCount?: number;
  autoResolvedCount?: number;
}

/**
 * Filters out terminal sessions and maps server task data to CodingAgentSession objects.
 * Extracted from AppContext so it can be tested independently.
 */
export function mapServerTasksToSessions(
  tasks: ServerTask[],
): CodingAgentSession[] {
  return tasks
    .filter((t) => !TERMINAL_STATUSES.has(t.status ?? ""))
    .map((t) => ({
      sessionId: t.sessionId,
      agentType: t.agentType ?? "claude",
      label: t.label ?? t.sessionId,
      originalTask: t.originalTask ?? "",
      workdir: t.workdir ?? "",
      status: (t.status ?? "active") as CodingAgentSession["status"],
      decisionCount: t.decisionCount ?? 0,
      autoResolvedCount: t.autoResolvedCount ?? 0,
    }));
}
