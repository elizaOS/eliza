/**
 * TRIGGER — recurring/scheduled trigger lifecycle as a Pattern-C op-dispatch
 * action.
 *
 * Ops:
 *   create — create a trigger (interval / once / cron) with instructions and
 *            wakeMode. Enforces a per-creator limit and dedupes on
 *            (type, instructions, schedule).
 *   update — patch displayName / instructions / schedule / wakeMode / maxRuns.
 *   delete — remove a trigger task.
 *   run    — fire a trigger immediately (manual run, force=true).
 *   toggle — flip enabled, or set to a specific value via `enabled`.
 *
 * Triggers are persisted as runtime Tasks tagged with TRIGGER_TASK_TAGS and
 * carry a {@link TriggerConfig} in their metadata. Workbench tasks (TASK
 * action) and trigger tasks share a table but are kept distinct via tag.
 */
import crypto from "node:crypto";
import {
  type Action,
  type ActionExample,
  type ActionResult,
  asUUID,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
  stringToUuid,
  type Task,
  TRIGGER_SCHEMA_VERSION,
  type TriggerConfig,
  type TriggerType,
  type TriggerWakeMode,
  type UUID,
} from "@elizaos/core";

import {
  executeTriggerTask,
  readTriggerConfig,
  TRIGGER_TASK_NAME,
  TRIGGER_TASK_TAGS,
} from "../triggers/runtime.ts";
import {
  buildTriggerMetadata,
  normalizeTriggerIntervalMs,
  parseCronExpression,
  parseScheduledAtIso,
} from "../triggers/scheduling.ts";
import { deployTextTriggerWorkflow } from "../triggers/text-to-workflow.ts";
import type { TriggerTaskMetadata } from "../triggers/types.ts";

type AutonomyRoomService = {
  getAutonomousRoomId?(): UUID;
};

function isAutonomyRoomService(
  service: unknown,
): service is AutonomyRoomService {
  return typeof service === "object" && service !== null;
}

const TRIGGER_OPS = ["create", "update", "delete", "run", "toggle"] as const;
type TriggerOp = (typeof TRIGGER_OPS)[number];

const TRIGGER_ACTION = "TRIGGER";
const MAX_TRIGGERS_PER_CREATOR = 100;
const DEFAULT_INTERVAL_MS = 12 * 60 * 60 * 1000;

interface TriggerParameters {
  action?: string;
  subaction?: string;
  op?: string;
  taskId?: string;
  triggerType?: string;
  displayName?: string;
  instructions?: string;
  wakeMode?: string;
  intervalMs?: string | number;
  scheduledAtIso?: string;
  cronExpression?: string;
  maxRuns?: string | number;
  enabled?: boolean | string;
}

function readParams(options?: HandlerOptions): TriggerParameters {
  const raw = options?.parameters;
  if (!raw || typeof raw !== "object") return {};
  return raw as TriggerParameters;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readUuid(value: unknown): UUID | undefined {
  const str = readString(value);
  return str ? asUUID(str) : undefined;
}

function readBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
    if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  }
  return fallback;
}

function parsePositiveInt(raw: unknown): number | undefined {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

function failed(
  op: TriggerOp | string,
  text: string,
  error?: string,
  data?: Record<string, unknown>,
): ActionResult {
  const code = `TRIGGER_${op.toUpperCase()}_FAILED`;
  return {
    success: false,
    text,
    error: error ?? code,
    values: { op, error: error ?? code },
    data: { actionName: TRIGGER_ACTION, op, error: error ?? code, ...data },
  };
}

function ok(
  op: TriggerOp,
  text: string,
  data?: Record<string, unknown>,
  values?: Record<string, unknown>,
): ActionResult {
  return {
    success: true,
    text,
    values: { op, ...(values ?? {}) },
    data: { actionName: TRIGGER_ACTION, op, ...(data ?? {}) },
  };
}

function deriveTriggerType(p: TriggerParameters): TriggerType {
  const t = p.triggerType?.trim().toLowerCase();
  if (t === "interval" || t === "once" || t === "cron") return t;
  if (p.cronExpression?.trim()) return "cron";
  if (p.scheduledAtIso?.trim()) return "once";
  return "interval";
}

function dedupeHash(input: string): string {
  let h = 5381;
  for (const c of input) h = (h * 33) ^ c.charCodeAt(0);
  return `trigger-${Math.abs(h >>> 0).toString(16)}`;
}

function describeSchedule(t: TriggerConfig): string {
  if (t.triggerType === "interval")
    return `every ${t.intervalMs ?? DEFAULT_INTERVAL_MS}ms`;
  if (t.triggerType === "once") return `once at ${t.scheduledAtIso ?? "?"}`;
  return `cron ${t.cronExpression ?? "* * * * *"}`;
}

function triggersDisabled(runtime: IAgentRuntime): boolean {
  const setting = runtime.getSetting("ELIZA_TRIGGERS_ENABLED");
  if (setting === false || setting === "false" || setting === "0") return true;
  const env = process.env.ELIZA_TRIGGERS_ENABLED;
  return env === "0" || env === "false";
}

async function loadTriggerTask(
  runtime: IAgentRuntime,
  taskId: UUID,
): Promise<{ task: Task; trigger: TriggerConfig } | null> {
  const task = await runtime.getTask(taskId);
  if (!task?.id) return null;
  const trigger = readTriggerConfig(task);
  return trigger ? { task, trigger } : null;
}

function isTriggerOp(value: string): value is TriggerOp {
  return (TRIGGER_OPS as readonly string[]).includes(value);
}

async function opCreate(
  runtime: IAgentRuntime,
  message: Memory,
  params: TriggerParameters,
): Promise<ActionResult> {
  if (!runtime.enableAutonomy) {
    return failed("create", "Autonomy is disabled.", "AUTONOMY_OFF");
  }
  if (triggersDisabled(runtime)) {
    return failed("create", "Triggers are disabled.", "TRIGGERS_OFF");
  }
  const text = readString(message.content.text) ?? "";
  const instructions = readString(params.instructions) ?? text;
  if (!instructions) {
    return failed(
      "create",
      "instructions is required.",
      "MISSING_INSTRUCTIONS",
    );
  }
  const triggerType = deriveTriggerType(params);
  const displayName =
    readString(params.displayName) ?? `Trigger: ${instructions.slice(0, 64)}`;
  const wakeMode: TriggerWakeMode =
    params.wakeMode?.trim().toLowerCase() === "next_autonomy_cycle"
      ? "next_autonomy_cycle"
      : "inject_now";
  const creatorId = String(message.entityId ?? runtime.agentId);
  const intervalMs = normalizeTriggerIntervalMs(
    parsePositiveInt(params.intervalMs) ?? DEFAULT_INTERVAL_MS,
  );
  const scheduledAtIso = readString(params.scheduledAtIso);
  const cronExpression = readString(params.cronExpression);
  const maxRuns = parsePositiveInt(params.maxRuns);

  if (
    triggerType === "once" &&
    (!scheduledAtIso || parseScheduledAtIso(scheduledAtIso) === null)
  ) {
    return failed(
      "create",
      "Once trigger requires a valid scheduledAtIso.",
      "INVALID_SCHEDULE",
    );
  }
  if (
    triggerType === "cron" &&
    (!cronExpression || !parseCronExpression(cronExpression))
  ) {
    return failed(
      "create",
      "Cron trigger requires a valid 5-field cron expression.",
      "INVALID_CRON",
    );
  }

  const dedupeKey = dedupeHash(
    `${triggerType}|${instructions.toLowerCase()}|${intervalMs}|${scheduledAtIso ?? ""}|${cronExpression ?? ""}`,
  );

  const existingTasks = await runtime.getTasks({
    tags: [...TRIGGER_TASK_TAGS],
    agentIds: [runtime.agentId],
  });
  const ownedActive = existingTasks.filter((t) => {
    const cfg = readTriggerConfig(t);
    return cfg?.enabled && cfg.createdBy === creatorId;
  });
  if (ownedActive.length >= MAX_TRIGGERS_PER_CREATOR) {
    return failed(
      "create",
      `Trigger limit reached (${MAX_TRIGGERS_PER_CREATOR}).`,
      "LIMIT_REACHED",
    );
  }

  const duplicate = existingTasks.find((t) => {
    const cfg = readTriggerConfig(t);
    if (!cfg?.enabled) return false;
    if (cfg.dedupeKey) return cfg.dedupeKey === dedupeKey;
    return (
      cfg.instructions.trim().toLowerCase() === instructions.toLowerCase() &&
      cfg.triggerType === triggerType
    );
  });
  if (duplicate?.id) {
    return ok("create", "An equivalent trigger already exists.", {
      duplicateTaskId: duplicate.id,
      dedupeKey,
    });
  }

  // Phase 2E: every trigger persisted to disk is `kind: "workflow"`.
  // Materialize a single-node `respondToEvent` workflow that wraps the
  // user's instructions, then bind the trigger to it.
  const deployedWorkflow = await deployTextTriggerWorkflow(
    runtime,
    { displayName, instructions, wakeMode },
    creatorId,
  );
  if (!deployedWorkflow) {
    return failed(
      "create",
      "Workflow plugin is not loaded; cannot create text triggers.",
      "WORKFLOW_SERVICE_UNAVAILABLE",
    );
  }

  const triggerId = stringToUuid(crypto.randomUUID());
  const triggerConfig: TriggerConfig = {
    version: TRIGGER_SCHEMA_VERSION,
    triggerId,
    displayName,
    instructions,
    triggerType,
    enabled: true,
    wakeMode,
    createdBy: creatorId,
    runCount: 0,
    intervalMs: triggerType === "interval" ? intervalMs : undefined,
    scheduledAtIso: triggerType === "once" ? scheduledAtIso : undefined,
    cronExpression: triggerType === "cron" ? cronExpression : undefined,
    maxRuns,
    dedupeKey,
    kind: "workflow",
    workflowId: deployedWorkflow.id,
    workflowName: deployedWorkflow.name,
  };

  const metadata = buildTriggerMetadata({
    trigger: triggerConfig,
    nowMs: Date.now(),
  });
  if (!metadata) {
    return failed(
      "create",
      "Failed to compute trigger schedule.",
      "SCHEDULE_COMPUTE_FAILED",
    );
  }

  const service = runtime.getService("AUTONOMY");
  const autonomyService = isAutonomyRoomService(service) ? service : null;
  const roomId = autonomyService?.getAutonomousRoomId?.() ?? message.roomId;

  const taskId = await runtime.createTask({
    name: TRIGGER_TASK_NAME,
    description: displayName,
    roomId,
    tags: [...TRIGGER_TASK_TAGS],
    metadata,
  });

  return ok(
    "create",
    `Created trigger "${displayName}" (${describeSchedule(triggerConfig)}).`,
    {
      triggerId,
      taskId,
      triggerType,
      wakeMode,
      dedupeKey,
      kind: "workflow",
      workflowId: deployedWorkflow.id,
      workflowName: deployedWorkflow.name,
    },
    { triggerId, taskId, workflowId: deployedWorkflow.id },
  );
}

async function opUpdate(
  runtime: IAgentRuntime,
  params: TriggerParameters,
): Promise<ActionResult> {
  const taskId = readUuid(params.taskId);
  if (!taskId)
    return failed("update", "taskId is required.", "MISSING_TASK_ID");
  const loaded = await loadTriggerTask(runtime, taskId);
  if (!loaded)
    return failed(
      "update",
      `Trigger task not found: ${taskId}`,
      "TRIGGER_NOT_FOUND",
    );
  const { task, trigger } = loaded;
  if (!task.id) return failed("update", "Task missing id.", "TASK_NOT_FOUND");

  const next: TriggerConfig = { ...trigger };
  const displayName = readString(params.displayName);
  const instructions = readString(params.instructions);
  const intervalMs = parsePositiveInt(params.intervalMs);
  const scheduledAtIso = readString(params.scheduledAtIso);
  const cronExpression = readString(params.cronExpression);
  const maxRuns = parsePositiveInt(params.maxRuns);
  const wakeModeRaw = params.wakeMode?.trim().toLowerCase();

  if (displayName) next.displayName = displayName;
  if (instructions) next.instructions = instructions;
  if (intervalMs !== undefined && next.triggerType === "interval") {
    next.intervalMs = normalizeTriggerIntervalMs(intervalMs);
  }
  if (scheduledAtIso !== undefined && next.triggerType === "once") {
    if (parseScheduledAtIso(scheduledAtIso) === null) {
      return failed("update", "Invalid scheduledAtIso.", "INVALID_SCHEDULE");
    }
    next.scheduledAtIso = scheduledAtIso;
  }
  if (cronExpression !== undefined && next.triggerType === "cron") {
    if (!parseCronExpression(cronExpression)) {
      return failed("update", "Invalid cron expression.", "INVALID_CRON");
    }
    next.cronExpression = cronExpression;
  }
  if (maxRuns !== undefined) next.maxRuns = maxRuns;
  if (wakeModeRaw === "inject_now" || wakeModeRaw === "next_autonomy_cycle") {
    next.wakeMode = wakeModeRaw;
  }

  const metadata = buildTriggerMetadata({
    trigger: next,
    nowMs: Date.now(),
    existingMetadata: task.metadata as TriggerTaskMetadata | undefined,
  });
  if (!metadata) {
    return failed(
      "update",
      "Failed to recompute trigger schedule.",
      "SCHEDULE_COMPUTE_FAILED",
    );
  }
  await runtime.updateTask(task.id, {
    description: next.displayName,
    metadata,
  });
  return ok("update", `Updated trigger "${next.displayName}".`, {
    taskId: String(task.id),
    triggerId: next.triggerId,
  });
}

async function opDelete(
  runtime: IAgentRuntime,
  params: TriggerParameters,
): Promise<ActionResult> {
  const taskId = readUuid(params.taskId);
  if (!taskId)
    return failed("delete", "taskId is required.", "MISSING_TASK_ID");
  const loaded = await loadTriggerTask(runtime, taskId);
  if (!loaded)
    return failed(
      "delete",
      `Trigger task not found: ${taskId}`,
      "TRIGGER_NOT_FOUND",
    );
  if (!loaded.task.id)
    return failed("delete", "Task missing id.", "TASK_NOT_FOUND");
  await runtime.deleteTask(loaded.task.id);
  return ok("delete", `Deleted trigger "${loaded.trigger.displayName}".`, {
    taskId: String(loaded.task.id),
  });
}

async function opRun(
  runtime: IAgentRuntime,
  params: TriggerParameters,
): Promise<ActionResult> {
  const taskId = readUuid(params.taskId);
  if (!taskId) return failed("run", "taskId is required.", "MISSING_TASK_ID");
  const loaded = await loadTriggerTask(runtime, taskId);
  if (!loaded)
    return failed(
      "run",
      `Trigger task not found: ${taskId}`,
      "TRIGGER_NOT_FOUND",
    );
  const result = await executeTriggerTask(runtime, loaded.task, {
    source: "manual",
    force: true,
  });
  if (result.status === "error") {
    return failed(
      "run",
      `Trigger run failed: ${result.error ?? "unknown error"}`,
      "RUN_FAILED",
      { triggerId: loaded.trigger.triggerId },
    );
  }
  return ok("run", `Ran trigger "${loaded.trigger.displayName}".`, {
    taskId: String(loaded.task.id),
    triggerId: loaded.trigger.triggerId,
    status: result.status,
    taskDeleted: result.taskDeleted,
  });
}

async function opToggle(
  runtime: IAgentRuntime,
  params: TriggerParameters,
): Promise<ActionResult> {
  const taskId = readUuid(params.taskId);
  if (!taskId)
    return failed("toggle", "taskId is required.", "MISSING_TASK_ID");
  const loaded = await loadTriggerTask(runtime, taskId);
  if (!loaded)
    return failed(
      "toggle",
      `Trigger task not found: ${taskId}`,
      "TRIGGER_NOT_FOUND",
    );
  const { task, trigger } = loaded;
  if (!task.id) return failed("toggle", "Task missing id.", "TASK_NOT_FOUND");
  const enabled =
    params.enabled === undefined ? !trigger.enabled : readBool(params.enabled);
  const next: TriggerConfig = { ...trigger, enabled };
  const metadata = buildTriggerMetadata({
    trigger: next,
    nowMs: Date.now(),
    existingMetadata: task.metadata as TriggerTaskMetadata | undefined,
  });
  if (!metadata) {
    return failed(
      "toggle",
      "Failed to recompute trigger schedule.",
      "SCHEDULE_COMPUTE_FAILED",
    );
  }
  await runtime.updateTask(task.id, { metadata });
  return ok(
    "toggle",
    `${enabled ? "Enabled" : "Disabled"} trigger "${trigger.displayName}".`,
    { taskId: String(task.id), triggerId: trigger.triggerId, enabled },
  );
}

export const triggerAction: Action = {
  name: TRIGGER_ACTION,
  contexts: ["automation", "tasks", "agent_internal"],
  roleGate: { minRole: "ADMIN" },
  similes: [],
  description:
    "Recurring/scheduled trigger lifecycle. Action-based dispatch (create / update / delete / run / toggle). Supports interval, once, and cron schedules with wakeMode control.",
  descriptionCompressed:
    "trigger lifecycle: create update delete run toggle (interval|once|cron)",
  suppressPostActionContinuation: true,

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions,
  ): Promise<boolean> => {
    const params = readParams(options);
    const op = readString(params.action ?? params.subaction ?? params.op);
    return op !== undefined && isTriggerOp(op);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = readParams(options);
    const opRaw = readString(
      params.action ?? params.subaction ?? params.op,
    )?.toLowerCase();
    if (!opRaw || !isTriggerOp(opRaw)) {
      const result = failed(
        "invalid",
        `Invalid action. Expected one of: ${TRIGGER_OPS.join(", ")}.`,
        "TRIGGER_INVALID",
      );
      if (callback) {
        await callback({ text: result.text ?? "", action: TRIGGER_ACTION });
      }
      return result;
    }
    const op: TriggerOp = opRaw;

    let result: ActionResult;
    switch (op) {
      case "create":
        result = await opCreate(runtime, message, params);
        break;
      case "update":
        result = await opUpdate(runtime, params);
        break;
      case "delete":
        result = await opDelete(runtime, params);
        break;
      case "run":
        result = await opRun(runtime, params);
        break;
      case "toggle":
        result = await opToggle(runtime, params);
        break;
    }

    if (callback) {
      await callback({
        text: result.text ?? "",
        action: TRIGGER_ACTION,
        metadata: { op, ...(result.values ?? {}) },
      });
    }
    return result;
  },

  parameters: [
    {
      name: "action",
      description: `Action: ${TRIGGER_OPS.join(", ")}.`,
      required: true,
      schema: { type: "string" as const, enum: [...TRIGGER_OPS] },
    },
    {
      name: "taskId",
      description:
        "Trigger task UUID. Required for update / delete / run / toggle.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "triggerType",
      description: "Trigger schedule type for create.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["interval", "once", "cron"],
      },
    },
    {
      name: "displayName",
      description: "Trigger display name (create / update).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "instructions",
      description: "Trigger instructions (create / update).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "wakeMode",
      description: "How the trigger wakes the agent.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["inject_now", "next_autonomy_cycle"],
      },
    },
    {
      name: "intervalMs",
      description: "Interval frequency in ms.",
      required: false,
      schema: { type: "number" as const, minimum: 1 },
    },
    {
      name: "scheduledAtIso",
      description: "ISO timestamp for once-triggers.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "cronExpression",
      description: "Five-field cron expression.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "maxRuns",
      description: "Optional max runs for a trigger.",
      required: false,
      schema: { type: "number" as const, minimum: 1 },
    },
    {
      name: "enabled",
      description: "Enable or disable a trigger (toggle).",
      required: false,
      schema: { type: "boolean" as const },
    },
  ],

  examples: [
    [
      {
        name: "{{user}}",
        content: {
          text: "Create a trigger every 12 hours to review open PRs.",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'Created trigger "Trigger: review open PRs" (every 43200000ms).',
          action: TRIGGER_ACTION,
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "Disable that PR review trigger for now." },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'Disabled trigger "Trigger: review open PRs".',
          action: TRIGGER_ACTION,
        },
      },
    ],
  ] as ActionExample[][],
};

export { TRIGGER_OPS };
