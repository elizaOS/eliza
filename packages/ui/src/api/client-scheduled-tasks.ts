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
