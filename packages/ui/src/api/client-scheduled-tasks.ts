import { ElizaClient } from "./client-base";
import type {
  ScheduledTaskListFilter,
  ScheduledTaskListResponse,
  ScheduledTaskView,
} from "./client-types-core";

/**
 * Owner-facing scheduled-task verbs (`POST /api/lifeops/scheduled-tasks/:id/<verb>`).
 * These are exactly the runner's frozen `ScheduledTaskVerb` set.
 */
export type ScheduledTaskVerbName =
  | "snooze"
  | "skip"
  | "complete"
  | "dismiss"
  | "escalate"
  | "acknowledge"
  | "edit"
  | "reopen";

/**
 * Typed outcome of firing a scheduled task on demand
 * (`POST /api/lifeops/scheduled-tasks/:id/fire`). Mirrors the runner's
 * `ScheduledTaskFireResult` discriminated union, flattened for the wire:
 * - `fired` — the task fired and dispatched.
 * - `skipped` — a `shouldFire` gate denied it (with `reason`).
 * - `dispatch_deferred` — dispatch failed transiently; retried at `nextAttemptAtIso`.
 * - `dispatch_failed` — dispatch failed terminally (`error` message).
 * - `raced` — another tick claimed the row first.
 */
export interface ScheduledTaskFireResult {
  kind: "fired" | "raced" | "skipped" | "dispatch_deferred" | "dispatch_failed";
  reason?: string;
  error?: string;
  nextAttemptAtIso?: string;
  task: ScheduledTaskView | null;
}

declare module "./client-base" {
  interface ElizaClient {
    /**
     * List LifeOps scheduled tasks (`GET /api/lifeops/scheduled-tasks`).
     *
     * The route is served by `@elizaos/plugin-personal-assistant`. It is not
     * hosted on every target (e.g. mobile, or builds without LifeOps), where
     * it 404s — callers treat that as an empty list, mirroring
     * `listAutomations`.
     */
    listScheduledTasks(
      filter?: ScheduledTaskListFilter,
    ): Promise<ScheduledTaskListResponse>;

    /**
     * Apply an owner verb to a scheduled task
     * (`POST /api/lifeops/scheduled-tasks/:id/<verb>`). Returns the updated
     * task. Routes to the LifeOps runner — NOT the workflow CRUD endpoints.
     */
    applyScheduledTask(
      taskId: string,
      verb: ScheduledTaskVerbName,
      payload?: Record<string, unknown>,
    ): Promise<{ task: ScheduledTaskView }>;

    /**
     * Fire a scheduled task on demand — the interactive HITL live-test trigger
     * (`POST /api/lifeops/scheduled-tasks/:id/fire`). Runs the task immediately
     * regardless of due-ness (the same strict-fire path the scheduler tick
     * uses) and returns the typed outcome. Routes to the LifeOps runner.
     */
    fireScheduledTask(
      taskId: string,
    ): Promise<{ fire: ScheduledTaskFireResult }>;

    /**
     * Run a one-click LifeOps live-validation probe
     * (`POST /api/lifeops/scheduled-tasks/test-probe`). Seeds a due-now
     * reminder (default) or check-in and fires it in the same call, returning
     * the seeded task and the typed fire outcome — the "click and it runs"
     * entry point for the HITL test surface.
     */
    runLifeOpsTestProbe(
      kind?: "reminder" | "checkin",
    ): Promise<{ task: ScheduledTaskView; fire: ScheduledTaskFireResult }>;
  }
}

function buildQuery(filter?: ScheduledTaskListFilter): string {
  if (!filter) return "";
  const params = new URLSearchParams();
  if (filter.kind) params.set("kind", filter.kind);
  if (filter.status) params.set("status", filter.status);
  if (filter.source) params.set("source", filter.source);
  if (filter.firedSince) params.set("firedSince", filter.firedSince);
  if (filter.ownerVisibleOnly) params.set("ownerVisibleOnly", "1");
  const query = params.toString();
  return query ? `?${query}` : "";
}

ElizaClient.prototype.listScheduledTasks = async function (
  this: ElizaClient,
  filter?: ScheduledTaskListFilter,
): Promise<ScheduledTaskListResponse> {
  const res = await this.fetch<{ tasks?: ScheduledTaskView[] }>(
    `/api/lifeops/scheduled-tasks${buildQuery(filter)}`,
  );
  return { tasks: Array.isArray(res?.tasks) ? res.tasks : [] };
};

ElizaClient.prototype.applyScheduledTask = async function (
  this: ElizaClient,
  taskId: string,
  verb: ScheduledTaskVerbName,
  payload?: Record<string, unknown>,
): Promise<{ task: ScheduledTaskView }> {
  return this.fetch<{ task: ScheduledTaskView }>(
    `/api/lifeops/scheduled-tasks/${encodeURIComponent(taskId)}/${verb}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    },
  );
};

ElizaClient.prototype.fireScheduledTask = async function (
  this: ElizaClient,
  taskId: string,
): Promise<{ fire: ScheduledTaskFireResult }> {
  return this.fetch<{ fire: ScheduledTaskFireResult }>(
    `/api/lifeops/scheduled-tasks/${encodeURIComponent(taskId)}/fire`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
};

ElizaClient.prototype.runLifeOpsTestProbe = async function (
  this: ElizaClient,
  kind?: "reminder" | "checkin",
): Promise<{ task: ScheduledTaskView; fire: ScheduledTaskFireResult }> {
  return this.fetch<{ task: ScheduledTaskView; fire: ScheduledTaskFireResult }>(
    "/api/lifeops/scheduled-tasks/test-probe",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(kind ? { kind } : {}),
    },
  );
};
