import type { CodingAgentSession } from "../api/client-types-cloud";

export const STATUS_DOT: Record<string, string> = {
  active: "bg-ok",
  tool_running: "bg-accent",
  blocked: "bg-warn",
  error: "bg-danger",
};

export const PULSE_STATUSES = new Set(["active", "tool_running"]);

export const TERMINAL_STATUSES = new Set([
  "completed",
  "stopped",
  "error",
  "interrupted",
]);

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

export function mapServerTasksToSessions(
  tasks: ServerTask[],
): CodingAgentSession[] {
  return tasks
    .filter((task) => !TERMINAL_STATUSES.has(task.status ?? ""))
    .map((task) => ({
      sessionId: task.sessionId,
      agentType: task.agentType ?? "claude",
      label: task.label ?? task.sessionId,
      originalTask: task.originalTask ?? "",
      workdir: task.workdir ?? "",
      status: (task.status ?? "active") as CodingAgentSession["status"],
      decisionCount: task.decisionCount ?? 0,
      autoResolvedCount: task.autoResolvedCount ?? 0,
    }));
}
