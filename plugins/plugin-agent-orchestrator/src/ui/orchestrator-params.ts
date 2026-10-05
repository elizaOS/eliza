// Shared orchestrator param coercion helpers + small constants used by both
// OrchestratorWorkbench.tsx (the React workbench) and the capability dispatcher
// in orchestrator-capabilities.ts. Kept out of the .tsx so that file exports
// only React components and stays Fast-Refresh-compatible in dev.
import type { CodingAgentTaskThread } from "@elizaos/ui";

export type TaskPriority = CodingAgentTaskThread["priority"];

export const TASK_LIST_LIMIT = 100;

export function paramString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function paramPriority(value: unknown): TaskPriority | undefined {
  return value === "low" ||
    value === "normal" ||
    value === "high" ||
    value === "urgent"
    ? value
    : undefined;
}

export function paramStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim() !== "",
  );
  return items.length > 0 ? items.map((entry) => entry.trim()) : undefined;
}

export function requireTaskId(params?: Record<string, unknown>): string {
  const taskId = paramString(params?.taskId);
  if (!taskId) throw new Error("taskId is required for this capability.");
  return taskId;
}
