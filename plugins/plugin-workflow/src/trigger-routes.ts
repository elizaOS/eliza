import crypto from "node:crypto";
import {
  type TriggerRunRecord as CoreTriggerRunRecord,
  type IAgentRuntime,
  type RouteRequestContext,
  stringToUuid,
  type Task,
  type TriggerConfig,
  type TriggerKind,
  type TriggerType,
  type TriggerWakeMode,
  type UUID,
} from "@elizaos/core";
import type { RouteHelpers } from "@elizaos/shared";
import type {
  TriggerExecutionOptions,
  TriggerExecutionResult,
} from "@elizaos/agent";
import type {
  DeployedTriggerWorkflow,
  TextTriggerWorkflowDraft,
} from "../triggers/text-to-workflow.js";
import type {
  NormalizedTriggerDraft,
  TriggerHealthSnapshot,
  TriggerSummary,
  TriggerTaskMetadata,
} from "@elizaos/agent";

export type TriggerRouteHelpers = RouteHelpers;

interface TriggerDraftInput {
  displayName?: string;
  instructions?: string;
  triggerType?: TriggerType;
  wakeMode?: TriggerWakeMode;
  enabled?: boolean;
  createdBy?: string;
  timezone?: string;
  intervalMs?: number;
  scheduledAtIso?: string;
  cronExpression?: string;
  eventKind?: string;
  maxRuns?: number;
  kind?: TriggerKind;
  workflowId?: string;
  workflowName?: string;
}

interface NormalizeTriggerDraftFallback {
  displayName: string;
  instructions: string;
  triggerType: TriggerType;
  wakeMode: TriggerWakeMode;
  enabled: boolean;
  createdBy: string;
}

export interface TriggerRouteContext extends RouteRequestContext {
  runtime: IAgentRuntime | null;
  executeTriggerTask: (
    runtime: IAgentRuntime,
    task: Task,
    options: TriggerExecutionOptions,
  ) => Promise<TriggerExecutionResult>;
  getTriggerHealthSnapshot: (
    runtime: IAgentRuntime,
  ) => Promise<TriggerHealthSnapshot>;
  getTriggerLimit: (runtime: IAgentRuntime) => number;
  listTriggerTasks: (runtime: IAgentRuntime) => Promise<Task[]>;
  readTriggerConfig: (task: Task) => TriggerConfig | null;
  readTriggerRuns: (task: Task) => CoreTriggerRunRecord[];
  taskToTriggerSummary: (task: Task) => TriggerSummary | null;
  triggersFeatureEnabled: (runtime: IAgentRuntime) => boolean;
  buildTriggerConfig: (params: {
    draft: NormalizedTriggerDraft;
    triggerId: UUID;
    previous?: TriggerConfig;
  }) => TriggerConfig;
  buildTriggerMetadata: (params: {
    existingMetadata?: TriggerTaskMetadata;
    trigger: TriggerConfig;
    nowMs: number;
  }) => TriggerTaskMetadata | null;
  normalizeTriggerDraft: (params: {
    input: TriggerDraftInput;
    fallback: NormalizeTriggerDraftFallback;
  }) => { draft?: NormalizedTriggerDraft; error?: string };
  /**
   * Phase 2E: every persisted trigger is `kind: "workflow"`. When the
   * caller submits `kind: "text"` (or omits `kind`), the route uses this
   * to materialize a single-node `respondToEvent` workflow first, then
   * stores the trigger as `kind: "workflow"` pointing at that workflow.
   */
  deployTextTriggerWorkflow: (
    runtime: IAgentRuntime,
    draft: TextTriggerWorkflowDraft,
    ownerId: string,
  ) => Promise<DeployedTriggerWorkflow | null>;
  DISABLED_TRIGGER_INTERVAL_MS: number;
  TRIGGER_TASK_NAME: string;
  TRIGGER_TASK_TAGS: string[];
}

function trim(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function parseTriggerKind(value: unknown): TriggerKind | undefined {
  if (value === "text" || value === "workflow") return value;
  return undefined;
}

type ParsedTriggerKind =
  | { ok: true; kind: TriggerKind }
  | { ok: false; error: string };

function parseTriggerKindStrict(value: unknown): ParsedTriggerKind | undefined {
  if (value === undefined) return undefined;
  if (value === "text" || value === "workflow")
    return { ok: true, kind: value };
  return { ok: false, error: "kind must be 'text' or 'workflow'" };
}

function parseNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseEventPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeTriggerPath(pathname: string): {
  normalizedPathname: string;
  usingHeartbeatsAlias: boolean;
} {
  if (pathname === "/api/heartbeats") {
    return {
      normalizedPathname: "/api/triggers",
      usingHeartbeatsAlias: true,
    };
  }
  if (pathname.startsWith("/api/heartbeats/")) {
    return {
      normalizedPathname: pathname.replace("/api/heartbeats", "/api/triggers"),
      usingHeartbeatsAlias: true,
    };
  }
  return {
    normalizedPathname: pathname,
    usingHeartbeatsAlias: false,
  };
}

async function findTask(
  runtime: IAgentRuntime,
  id: string,
  listTriggerTasks: (runtime: IAgentRuntime) => Promise<Task[]>,
  readTriggerConfig: (task: Task) => TriggerConfig | null,
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
    deployTextTriggerWorkflow,
    DISABLED_TRIGGER_INTERVAL_MS,
    TRIGGER_TASK_NAME,
    TRIGGER_TASK_TAGS,
  } = ctx;

  const { normalizedPathname, usingHeartbeatsAlias } =
    normalizeTriggerPath(pathname);
  const listResponse = (triggers: TriggerSummary[], status = 200): void => {
    json(
      res,
      usingHeartbeatsAlias ? { triggers, heartbeats: triggers } : { triggers },
      status,
    );
  };
  const itemResponse = (summary: TriggerSummary, status = 200): void => {
    json(
      res,
      usingHeartbeatsAlias
        ? { trigger: summary, heartbeat: summary }
        : { trigger: summary },
      status,
    );
  };

  if (
    !normalizedPathname.startsWith("/api/triggers") &&
    !pathname.startsWith("/api/heartbeats")
  )
    return false;
  if (!runtime) {
    error(res, "Agent is not running", 503);
    return true;
  }
  if (
    !triggersFeatureEnabled(runtime) &&
    normalizedPathname !== "/api/triggers/health"
  ) {
    error(res, "Triggers are disabled by configuration", 503);
    return true;
  }

  if (method === "GET" && normalizedPathname === "/api/triggers/health") {
    json(res, await getTriggerHealthSnapshot(runtime));
    return true;
  }

  if (method === "GET" && normalizedPathname === "/api/triggers") {
    const tasks = await listTriggerTasks(runtime);
    const triggers = tasks
      .map(taskToTriggerSummary)
      .filter((summary): summary is TriggerSummary => summary !== null)
      .sort((a, b) =>
        String(a.displayName ?? "").localeCompare(String(b.displayName ?? "")),
      );
    listResponse(triggers);
    return true;
  }

  if (method === "POST" && normalizedPathname === "/api/triggers") {
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;

    const creator =
      typeof body.createdBy === "string"
        ? trim(body.createdBy) || "api"
        : "api";
    const kindParsed = parseTriggerKindStrict(body.kind);
    if (kindParsed !== undefined && kindParsed.ok === false) {
      error(res, kindParsed.error, 400);
      return true;
    }
    const requestedKind: TriggerKind | undefined = kindParsed?.ok
      ? kindParsed.kind
      : undefined;
    let workflowId = parseNonEmptyString(body.workflowId);
    let workflowName = parseNonEmptyString(body.workflowName);
    if (requestedKind === "workflow" && !workflowId) {
      error(res, "workflowId is required when kind is 'workflow'", 400);
      return true;
    }

    // Phase 2E: when the client submits `kind: "text"` or omits `kind`,
    // materialize a single-node `respondToEvent` workflow up front so the
    // persisted trigger is always `kind: "workflow"`.
    if (requestedKind !== "workflow") {
      const rawDisplayName =
        typeof body.displayName === "string" && trim(body.displayName)
          ? trim(body.displayName)
          : "New Trigger";
      const rawInstructions =
        typeof body.instructions === "string" ? trim(body.instructions) : "";
      if (!rawInstructions) {
        error(res, "instructions is required", 400);
        return true;
      }
      const wakeModeForWorkflow: TriggerWakeMode =
        typeof body.wakeMode === "string" &&
        body.wakeMode === "next_autonomy_cycle"
          ? "next_autonomy_cycle"
          : "inject_now";
      const deployed = await deployTextTriggerWorkflow(
        runtime,
        {
          displayName: rawDisplayName,
          instructions: rawInstructions,
          wakeMode: wakeModeForWorkflow,
        },
        creator,
      );
      if (!deployed) {
        error(
          res,
          "Workflow plugin is not loaded; cannot create text triggers.",
          503,
        );
        return true;
      }
      workflowId = deployed.id;
      workflowName = deployed.name;
    }

    const kind: TriggerKind = "workflow";
    const inputDraft: TriggerDraftInput = {
      displayName:
        typeof body.displayName === "string" ? body.displayName : undefined,
      instructions:
        typeof body.instructions === "string" ? body.instructions : undefined,
      triggerType:
        typeof body.triggerType === "string"
          ? (body.triggerType as TriggerType)
          : undefined,
      wakeMode:
        typeof body.wakeMode === "string"
          ? (body.wakeMode as TriggerWakeMode)
          : undefined,
      enabled: !!(body.enabled ?? true),
      createdBy: creator,
      timezone: typeof body.timezone === "string" ? body.timezone : undefined,
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
      eventKind:
        typeof body.eventKind === "string" ? body.eventKind : undefined,
      maxRuns: typeof body.maxRuns === "number" ? body.maxRuns : undefined,
      kind,
      workflowId,
      workflowName,
    };
    const normalized = normalizeTriggerDraft({
      input: inputDraft,
      fallback: {
        displayName:
          typeof body.displayName === "string" && trim(body.displayName)
            ? trim(body.displayName)
            : "New Trigger",
        instructions:
          typeof body.instructions === "string" ? trim(body.instructions) : "",
        triggerType:
          typeof body.triggerType === "string"
            ? (body.triggerType as TriggerType)
            : "interval",
        wakeMode:
          typeof body.wakeMode === "string"
            ? (body.wakeMode as TriggerWakeMode)
            : "inject_now",
        enabled: body.enabled === undefined ? true : body.enabled === true,
        createdBy: creator,
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

    const nowMs = Date.now();
    const metadata = trigger.enabled
      ? buildTriggerMetadata({ trigger, nowMs })
      : ({
          updatedAt: nowMs,
          updateInterval: DISABLED_TRIGGER_INTERVAL_MS,
          trigger: {
            ...trigger,
            nextRunAtMs: nowMs + DISABLED_TRIGGER_INTERVAL_MS,
          },
        } as TriggerTaskMetadata);
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
    itemResponse(summary, 201);
    return true;
  }

  const runsMatch = /^\/api\/triggers\/([^/]+)\/runs$/.exec(normalizedPathname);
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

  const execMatch = /^\/api\/triggers\/([^/]+)\/execute$/.exec(
    normalizedPathname,
  );
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
    const result: TriggerExecutionResult = await executeTriggerTask(
      runtime,
      task,
      {
        source: "manual",
        force: true,
      },
    );
    const refreshed = task.id ? await runtime.getTask(task.id) : null;
    const summary = refreshed
      ? taskToTriggerSummary(refreshed)
      : (result.trigger ?? null);
    json(
      res,
      usingHeartbeatsAlias
        ? { ok: true, result, trigger: summary, heartbeat: summary }
        : { ok: true, result, trigger: summary },
    );
    return true;
  }

  const eventMatch = /^\/api\/triggers\/events\/([^/]+)$/.exec(
    normalizedPathname,
  );
  if (method === "POST" && eventMatch) {
    const eventKind = decodeURIComponent(eventMatch[1] ?? "").trim();
    if (!eventKind) {
      error(res, "event kind is required", 400);
      return true;
    }

    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;
    const payload = parseEventPayload(body.payload ?? body);
    const tasks = await listTriggerTasks(runtime);
    const matchingTasks = tasks.filter((task) => {
      const trigger = readTriggerConfig(task);
      return (
        trigger?.enabled === true &&
        trigger.triggerType === "event" &&
        trigger.eventKind === eventKind
      );
    });
    const results: Array<{
      taskId: string | undefined;
      result: Awaited<ReturnType<typeof executeTriggerTask>>;
      trigger: ReturnType<typeof taskToTriggerSummary> | null;
    }> = [];
    for (const task of matchingTasks) {
      const result = await executeTriggerTask(runtime, task, {
        source: "event",
        event: { kind: eventKind, payload },
      });
      const refreshed = task.id ? await runtime.getTask(task.id) : null;
      results.push({
        taskId: task.id,
        result,
        trigger: refreshed
          ? taskToTriggerSummary(refreshed)
          : (result.trigger ?? null),
      });
    }
    json(res, {
      ok: true,
      eventKind,
      matched: matchingTasks.length,
      results,
    });
    return true;
  }

  const itemMatch = /^\/api\/triggers\/([^/]+)$/.exec(normalizedPathname);
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
    itemResponse(summary);
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

    const kindParsed = parseTriggerKindStrict(body.kind);
    if (kindParsed !== undefined && kindParsed.ok === false) {
      error(res, kindParsed.error, 400);
      return true;
    }
    const parsedKind: TriggerKind | undefined = kindParsed?.ok
      ? kindParsed.kind
      : undefined;
    const nextKind: TriggerKind | undefined =
      parsedKind ?? parseTriggerKind(current.kind);
    const nextWorkflowId =
      parseNonEmptyString(body.workflowId) ?? current.workflowId;
    const nextWorkflowName =
      parseNonEmptyString(body.workflowName) ?? current.workflowName;
    if (nextKind === "workflow" && !nextWorkflowId) {
      error(res, "workflowId is required when kind is 'workflow'", 400);
      return true;
    }

    const mergedInput: TriggerDraftInput = {
      displayName:
        typeof body.displayName === "string" ? body.displayName : undefined,
      instructions:
        typeof body.instructions === "string" ? body.instructions : undefined,
      triggerType:
        typeof body.triggerType === "string"
          ? (body.triggerType as TriggerType)
          : undefined,
      wakeMode:
        typeof body.wakeMode === "string"
          ? (body.wakeMode as TriggerWakeMode)
          : undefined,
      enabled:
        body.enabled === undefined ? current.enabled : body.enabled === true,
      createdBy: current.createdBy,
      timezone: typeof body.timezone === "string" ? body.timezone : undefined,
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
      eventKind:
        typeof body.eventKind === "string" ? body.eventKind : current.eventKind,
      maxRuns:
        typeof body.maxRuns === "number" ? body.maxRuns : current.maxRuns,
      kind: nextKind,
      workflowId: nextWorkflowId,
      workflowName: nextWorkflowName,
    };
    const normalized = normalizeTriggerDraft({
      input: mergedInput,
      fallback: {
        displayName: current.displayName,
        instructions: current.instructions,
        triggerType: current.triggerType,
        wakeMode: current.wakeMode,
        enabled:
          body.enabled === undefined ? current.enabled : body.enabled === true,
        createdBy: current.createdBy,
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
    const existingMeta = (task.metadata ?? {}) as TriggerTaskMetadata;
    const existingRuns = readTriggerRuns(task);

    let nextMeta: TriggerTaskMetadata;
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
    itemResponse(summary);
    return true;
  }

  return false;
}
