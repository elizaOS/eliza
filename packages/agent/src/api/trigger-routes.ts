import crypto from "node:crypto";
import {
  type AgentRuntime,
  stringToUuid,
  type Task,
  type UUID,
} from "@elizaos/core";
import type { TriggerSummary } from "../triggers/types";
import type { RouteHelpers, RouteRequestContext } from "./route-helpers";

export type TriggerRouteHelpers = RouteHelpers;

interface TriggerConfigLike {
  triggerId: string;
  displayName: string;
  instructions: string;
  triggerType: string;
  wakeMode: string;
  enabled: boolean;
  createdBy: string;
  dedupeKey?: string;
  intervalMs?: number;
  scheduledAtIso?: string;
  cronExpression?: string;
  maxRuns?: number;
  nextRunAtMs?: number;
}

type TriggerTaskMetadataLike = Record<string, unknown> & {
  triggerRuns?: unknown[];
};

type TriggerSummaryLike = Partial<TriggerSummary>;

type TriggerDraftLike = {
  displayName: string;
  instructions: string;
  triggerType: string;
  wakeMode: string;
  enabled: boolean;
  createdBy: string;
  intervalMs?: number;
  scheduledAtIso?: string;
  cronExpression?: string;
  maxRuns?: number;
};

export interface TriggerRouteContext extends RouteRequestContext {
  runtime: AgentRuntime | null;
  executeTriggerTask: (
    runtime: AgentRuntime,
    task: Task,
    options: { source: string; force: boolean },
  ) => Promise<unknown>;
  getTriggerHealthSnapshot: (runtime: AgentRuntime) => Promise<object>;
  getTriggerLimit: (runtime: AgentRuntime) => number;
  listTriggerTasks: (runtime: AgentRuntime) => Promise<Task[]>;
  readTriggerConfig: (task: Task) => TriggerConfigLike | null;
  readTriggerRuns: (task: Task) => unknown[];
  taskToTriggerSummary: (task: Task) => TriggerSummaryLike | null;
  triggersFeatureEnabled: (runtime: AgentRuntime) => boolean;
  buildTriggerConfig: (params: {
    draft: TriggerDraftLike;
    triggerId: string;
    previous?: TriggerConfigLike;
  }) => TriggerConfigLike;
  buildTriggerMetadata: (params: {
    existingMetadata?: TriggerTaskMetadataLike;
    trigger: TriggerConfigLike;
    nowMs: number;
  }) => TriggerTaskMetadataLike | null;
  normalizeTriggerDraft: (params: {
    input: Record<string, unknown>;
    fallback: TriggerDraftLike;
  }) => { draft?: TriggerDraftLike; error?: string };
  DISABLED_TRIGGER_INTERVAL_MS: number;
  TRIGGER_TASK_NAME: string;
  TRIGGER_TASK_TAGS: string[];
}

function trim(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

async function findTask(
  runtime: AgentRuntime,
  id: string,
  listTriggerTasks: (runtime: AgentRuntime) => Promise<Task[]>,
  readTriggerConfig: (task: Task) => TriggerConfigLike | null,
): Promise<Task | null> {
  const tasks = await listTriggerTasks(runtime);
  return (
    tasks.find((task) => {
      const trigger = readTriggerConfig(task);
      return trigger?.triggerId === id || task.id === id;
    }) ?? null
  );
}

export async function handleTriggerRoutes(
  ctx: TriggerRouteContext,
): Promise<boolean> {
  const {
    method,
    pathname,
    req,
    res,
    runtime,
    readJsonBody,
    json,
    error,
    executeTriggerTask,
    getTriggerHealthSnapshot,
    getTriggerLimit,
    listTriggerTasks,
    readTriggerConfig,
    readTriggerRuns,
    taskToTriggerSummary,
    triggersFeatureEnabled,
    buildTriggerConfig,
    buildTriggerMetadata,
    normalizeTriggerDraft,
    DISABLED_TRIGGER_INTERVAL_MS,
    TRIGGER_TASK_NAME,
    TRIGGER_TASK_TAGS,
  } = ctx;

  if (!pathname.startsWith("/api/triggers")) return false;
  if (!runtime) {
    error(res, "Agent is not running", 503);
    return true;
  }
  if (!triggersFeatureEnabled(runtime) && pathname !== "/api/triggers/health") {
    error(res, "Triggers are disabled by configuration", 503);
    return true;
  }

  if (method === "GET" && pathname === "/api/triggers/health") {
    json(res, await getTriggerHealthSnapshot(runtime));
    return true;
  }

  if (method === "GET" && pathname === "/api/triggers") {
    const tasks = await listTriggerTasks(runtime);
    const triggers = tasks
      .map(taskToTriggerSummary)
      .filter((summary): summary is TriggerSummaryLike => summary !== null)
      .sort((a, b) =>
        String(a.displayName ?? "").localeCompare(String(b.displayName ?? "")),
      );
    json(res, { triggers });
    return true;
  }

  if (method === "POST" && pathname === "/api/triggers") {
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;

    const creator =
      typeof body.createdBy === "string"
        ? trim(body.createdBy) || "api"
        : "api";
    const normalized = normalizeTriggerDraft({
      input: { ...body, enabled: body.enabled ?? true, createdBy: creator },
      fallback: {
        displayName:
          typeof body.displayName === "string" && trim(body.displayName)
            ? trim(body.displayName)
            : "New Trigger",
        instructions:
          typeof body.instructions === "string" ? trim(body.instructions) : "",
        triggerType:
          typeof body.triggerType === "string" ? body.triggerType : "interval",
        wakeMode:
          typeof body.wakeMode === "string" ? body.wakeMode : "inject_now",
        enabled: body.enabled === undefined ? true : body.enabled === true,
        createdBy: creator,
        intervalMs:
          typeof body.intervalMs === "number" ? body.intervalMs : undefined,
        scheduledAtIso:
          typeof body.scheduledAtIso === "string"
            ? body.scheduledAtIso
            : undefined,
        cronExpression:
          typeof body.cronExpression === "string"
            ? body.cronExpression
            : undefined,
        maxRuns: typeof body.maxRuns === "number" ? body.maxRuns : undefined,
      },
    });
    if (!normalized.draft) {
      error(res, normalized.error ?? "Invalid trigger request", 400);
      return true;
    }

    const existingTasks = await listTriggerTasks(runtime);
    const activeCount = existingTasks.filter((task) => {
      const trigger = readTriggerConfig(task);
      return trigger?.enabled && trigger.createdBy === creator;
    }).length;
    const limit = getTriggerLimit(runtime);
    if (activeCount >= limit) {
      error(res, `Active trigger limit reached (${limit})`, 429);
      return true;
    }

    const triggerId = stringToUuid(crypto.randomUUID());
    const trigger = buildTriggerConfig({ draft: normalized.draft, triggerId });

    const duplicate = existingTasks.find((task) => {
      const existingTrigger = readTriggerConfig(task);
      return (
        existingTrigger?.enabled &&
        existingTrigger.dedupeKey &&
        existingTrigger.dedupeKey === trigger.dedupeKey
      );
    });
    if (duplicate?.id) {
      error(res, "Equivalent trigger already exists", 409);
      return true;
    }

    const metadata = buildTriggerMetadata({ trigger, nowMs: Date.now() });
    if (!metadata) {
      error(res, "Unable to compute trigger schedule", 400);
      return true;
    }

    const roomId = (
      runtime.getService("AUTONOMY") as { getAutonomousRoomId?(): UUID } | null
    )?.getAutonomousRoomId?.();
    const taskId = await runtime.createTask({
      name: TRIGGER_TASK_NAME,
      description: trigger.displayName,
      roomId,
      tags: [...TRIGGER_TASK_TAGS],
      metadata: metadata as Task["metadata"],
    });
    const created = await runtime.getTask(taskId);
    const summary = created ? taskToTriggerSummary(created) : null;
    if (!summary) {
      error(res, "Trigger created but summary could not be generated", 500);
      return true;
    }
    json(res, { trigger: summary }, 201);
    return true;
  }

  const runsMatch = /^\/api\/triggers\/([^/]+)\/runs$/.exec(pathname);
  if (method === "GET" && runsMatch) {
    const task = await findTask(
      runtime,
      decodeURIComponent(runsMatch[1]),
      listTriggerTasks,
      readTriggerConfig,
    );
    if (!task) {
      error(res, "Trigger not found", 404);
      return true;
    }
    json(res, { runs: readTriggerRuns(task) });
    return true;
  }

  const execMatch = /^\/api\/triggers\/([^/]+)\/execute$/.exec(pathname);
  if (method === "POST" && execMatch) {
    const task = await findTask(
      runtime,
      decodeURIComponent(execMatch[1]),
      listTriggerTasks,
      readTriggerConfig,
    );
    if (!task) {
      error(res, "Trigger not found", 404);
      return true;
    }
    const result = await executeTriggerTask(runtime, task, {
      source: "manual",
      force: true,
    });
    const refreshed = task.id ? await runtime.getTask(task.id) : null;
    json(res, {
      ok: true,
      result,
      trigger: refreshed ? taskToTriggerSummary(refreshed) : null,
    });
    return true;
  }

  const itemMatch = /^\/api\/triggers\/([^/]+)$/.exec(pathname);
  if (!itemMatch) return false;
  const triggerId = decodeURIComponent(itemMatch[1]);

  if (method === "GET") {
    const task = await findTask(
      runtime,
      triggerId,
      listTriggerTasks,
      readTriggerConfig,
    );
    if (!task) {
      error(res, "Trigger not found", 404);
      return true;
    }
    const summary = taskToTriggerSummary(task);
    if (!summary) {
      error(res, "Trigger metadata is invalid", 500);
      return true;
    }
    json(res, { trigger: summary });
    return true;
  }

  if (method === "DELETE") {
    const task = await findTask(
      runtime,
      triggerId,
      listTriggerTasks,
      readTriggerConfig,
    );
    if (!task?.id) {
      error(res, "Trigger not found", 404);
      return true;
    }
    await runtime.deleteTask(task.id);
    json(res, { ok: true });
    return true;
  }

  if (method === "PUT") {
    const task = await findTask(
      runtime,
      triggerId,
      listTriggerTasks,
      readTriggerConfig,
    );
    if (!task?.id) {
      error(res, "Trigger not found", 404);
      return true;
    }
    const current = readTriggerConfig(task);
    if (!current) {
      error(res, "Trigger metadata is invalid", 500);
      return true;
    }

    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;

    const merged = {
      ...body,
      createdBy: current.createdBy,
      intervalMs:
        typeof body.intervalMs === "number"
          ? body.intervalMs
          : current.intervalMs,
      scheduledAtIso:
        typeof body.scheduledAtIso === "string"
          ? body.scheduledAtIso
          : current.scheduledAtIso,
      cronExpression:
        typeof body.cronExpression === "string"
          ? body.cronExpression
          : current.cronExpression,
      maxRuns:
        typeof body.maxRuns === "number" ? body.maxRuns : current.maxRuns,
    };
    const normalized = normalizeTriggerDraft({
      input: merged,
      fallback: {
        displayName: current.displayName,
        instructions: current.instructions,
        triggerType: current.triggerType,
        wakeMode: current.wakeMode,
        enabled:
          body.enabled === undefined ? current.enabled : body.enabled === true,
        createdBy: current.createdBy,
        intervalMs: current.intervalMs,
        scheduledAtIso: current.scheduledAtIso,
        cronExpression: current.cronExpression,
        maxRuns: current.maxRuns,
      },
    });
    if (!normalized.draft) {
      error(res, normalized.error ?? "Invalid update", 400);
      return true;
    }

    const nextTrigger = buildTriggerConfig({
      draft: normalized.draft,
      triggerId: current.triggerId,
      previous: current,
    });
    const existingMeta = (task.metadata ?? {}) as TriggerTaskMetadataLike;
    const existingRuns = readTriggerRuns(task);

    let nextMeta: TriggerTaskMetadataLike;
    if (!nextTrigger.enabled) {
      nextMeta = {
        ...existingMeta,
        updatedAt: Date.now(),
        updateInterval: DISABLED_TRIGGER_INTERVAL_MS,
        trigger: {
          ...nextTrigger,
          nextRunAtMs: Date.now() + DISABLED_TRIGGER_INTERVAL_MS,
        },
        triggerRuns: existingRuns,
      };
    } else {
      const built = buildTriggerMetadata({
        existingMetadata: existingMeta,
        trigger: nextTrigger,
        nowMs: Date.now(),
      });
      if (!built) {
        error(res, "Unable to compute trigger schedule", 400);
        return true;
      }
      nextMeta = built;
    }

    await runtime.updateTask(task.id, {
      description: nextTrigger.displayName,
      metadata: nextMeta as Task["metadata"],
    });
    const refreshed = await runtime.getTask(task.id);
    if (!refreshed) {
      error(res, "Trigger updated but no longer available", 500);
      return true;
    }
    const summary = taskToTriggerSummary(refreshed);
    if (!summary) {
      error(res, "Trigger metadata is invalid", 500);
      return true;
    }
    json(res, { trigger: summary });
    return true;
  }

  return false;
}
