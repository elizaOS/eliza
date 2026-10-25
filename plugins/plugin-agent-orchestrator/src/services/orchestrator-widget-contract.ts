/**
 * Stable, compact task snapshots for chat-adjacent orchestration widgets. The
 * contract derives display state from durable task DTOs while leaving detailed
 * task history on the existing per-task endpoints.
 */

import type { TaskThreadDto } from "./orchestrator-task-mapper.js";

export type OrchestratorWidgetStatus =
  | "queued"
  | "running"
  | "needs_input"
  | "completed"
  | "failed";

export interface OrchestratorWidgetTask {
  taskId: string;
  label: string;
  status: OrchestratorWidgetStatus;
  model?: string;
  account?: {
    providerId?: string;
    accountId?: string;
    label?: string;
  };
  progressSummary: string;
  evidenceLinks: Array<{ label: string; href: string }>;
  timestamps: {
    createdAt: string;
    updatedAt: string;
    completedAt?: string | null;
  };
  parentTaskId?: string;
  childTaskIds: string[];
}

export interface OrchestratorWidgetSnapshot {
  version: "orchestrator.widgets.v1";
  generatedAt: string;
  totalTaskCount: number;
  tasks: OrchestratorWidgetTask[];
}

function mapStatus(task: TaskThreadDto): OrchestratorWidgetStatus {
  if (task.admission?.state === "queued") return "queued";
  switch (task.status) {
    case "waiting_on_user":
    case "blocked":
      return "needs_input";
    case "done":
    case "archived":
      return "completed";
    case "failed":
    case "interrupted":
      return "failed";
    case "open":
    case "active":
    case "validating":
      return "running";
  }
}

function progressSummary(task: TaskThreadDto): string {
  if (task.summary?.trim()) return task.summary.trim();
  if (task.admission?.state === "queued") {
    return task.admission.position > 0
      ? `Queued at position ${task.admission.position}`
      : "Queued for an available coding-agent slot";
  }
  if (task.activeSessionCount > 0) {
    return task.latestSessionLabel
      ? `${task.latestSessionLabel} is working`
      : "Coding agent is working";
  }
  if (task.status === "validating") return "Checking completion evidence";
  if (task.status === "done") return "Completed";
  if (task.status === "failed") return "Failed";
  if (task.status === "waiting_on_user") return "Needs input from the owner";
  if (task.status === "blocked") return "Blocked";
  return "Task opened";
}

export function buildOrchestratorWidgetSnapshot(
  tasks: TaskThreadDto[],
  now: Date = new Date(),
  lineageTasks: TaskThreadDto[] = tasks,
): OrchestratorWidgetSnapshot {
  const childIdsByParent = new Map<string, string[]>();
  for (const task of lineageTasks) {
    const parentTaskId = task.parentTaskId;
    if (!parentTaskId) continue;
    const existing = childIdsByParent.get(parentTaskId) ?? [];
    existing.push(task.id);
    childIdsByParent.set(parentTaskId, existing);
  }
  for (const childIds of childIdsByParent.values()) childIds.sort();

  return {
    version: "orchestrator.widgets.v1",
    generatedAt: now.toISOString(),
    totalTaskCount: lineageTasks.length,
    tasks: tasks.map((task) => ({
      taskId: task.id,
      label: task.title,
      status: mapStatus(task),
      ...(task.latestSessionModel ? { model: task.latestSessionModel } : {}),
      ...(task.latestAccountProviderId ||
      task.latestAccountId ||
      task.latestAccountLabel
        ? {
            account: {
              ...(task.latestAccountProviderId
                ? { providerId: task.latestAccountProviderId }
                : {}),
              ...(task.latestAccountId
                ? { accountId: task.latestAccountId }
                : {}),
              ...(task.latestAccountLabel
                ? { label: task.latestAccountLabel }
                : {}),
            },
          }
        : {}),
      progressSummary: progressSummary(task),
      evidenceLinks: [
        {
          label: "details",
          href: `/api/orchestrator/tasks/${encodeURIComponent(task.id)}`,
        },
        {
          label: "events",
          href: `/api/orchestrator/tasks/${encodeURIComponent(task.id)}/events`,
        },
        {
          label: "stream",
          href: `/api/orchestrator/tasks/${encodeURIComponent(task.id)}/stream`,
        },
      ],
      timestamps: {
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        completedAt: task.closedAt,
      },
      ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
      childTaskIds: childIdsByParent.get(task.id) ?? [],
    })),
  };
}
