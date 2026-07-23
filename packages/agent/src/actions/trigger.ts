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
  AUTONOMY_SERVICE_TYPE,
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
  validateUuid,
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
// Cap for delaySeconds/delayMinutes. Far-future one-offs should use an
// absolute scheduledAtIso; unbounded delays overflow Date math (RangeError).
const MAX_RELATIVE_DELAY_MS = 366 * 24 * 60 * 60 * 1000;

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
  delaySeconds?: string | number;
  delayMinutes?: string | number;
  cronExpression?: string;
  maxRuns?: string | number;
  enabled?: boolean | string;
  workflowId?: string;
  workflowName?: string;
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
  // validateUuid, not asUUID: the id params accept planner-supplied strings
  // (names, fragments via aliases) — a non-UUID must fall through to the
  // name-fragment resolver, never throw out of the handler.
  return validateUuid(readString(value) ?? "") ?? undefined;
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
    // Floor BEFORE the positivity check: 0 < raw < 1 must be rejected, not
    // silently become 0 (a 0 delay schedules "now", which the task scheduler
    // treats as an invalid repeat and never fires).
    const n = Math.floor(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

// Relative-delay reminders ("remind me in 90 seconds / 5 minutes") arrive as a
// count, not an absolute time. `delaySeconds` wins over `delayMinutes` when both
// are present. Returns undefined when neither is a positive number.
function readRelativeDelayMs(p: TriggerParameters): number | undefined {
  const seconds = parsePositiveInt(p.delaySeconds);
  if (seconds !== undefined) return seconds * 1000;
  const minutes = parsePositiveInt(p.delayMinutes);
  if (minutes !== undefined) return minutes * 60_000;
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

/**
 * Resolve which trigger an update/delete/run/toggle refers to. Accepts a task
 * UUID, the triggerId, or — the way a person actually refers to one — a name
 * fragment matched against displayName/instructions. Users never see task
 * UUIDs, so demanding one made every "delete the X reminder" turn fail.
 * Exactly one match resolves; none or several return a structured failure
 * that lists the active triggers so the model can correct in one step.
 */
async function resolveTriggerRef(
  runtime: IAgentRuntime,
  op: TriggerOp,
  params: TriggerParameters,
): Promise<{ task: Task; trigger: TriggerConfig } | ActionResult> {
  const taskId = readUuid(params.taskId);
  if (taskId) {
    const loaded = await loadTriggerTask(runtime, taskId);
    if (loaded) return loaded;
  }
  const rawId = readString(params.taskId);
  const query = (
    readString(params.displayName) ??
    readString(params.instructions) ??
    ""
  )
    .toLowerCase()
    .replace(/^trigger:\s*/, "");

  const tasks = await runtime.getTasks({
    tags: [...TRIGGER_TASK_TAGS],
    agentIds: [runtime.agentId],
  });
  const all: Array<{ task: Task; trigger: TriggerConfig }> = [];
  for (const task of tasks) {
    const trigger = readTriggerConfig(task);
    if (trigger && task.id) all.push({ task, trigger });
  }
  const byTriggerId = rawId
    ? all.find((c) => String(c.trigger.triggerId) === rawId)
    : undefined;
  if (byTriggerId) return byTriggerId;

  const matches = query
    ? all.filter((c) => {
        const name = c.trigger.displayName
          .toLowerCase()
          .replace(/^trigger:\s*/, "");
        return (
          name.includes(query) ||
          query.includes(name) ||
          c.trigger.instructions.toLowerCase().includes(query)
        );
      })
    : [];
  if (matches.length === 1) return matches[0];

  const names = all.map((c) => `"${c.trigger.displayName}"`).join(", ");
  if (matches.length > 1) {
    return failed(
      op,
      `Several triggers match: ${matches.map((c) => `"${c.trigger.displayName}"`).join(", ")}. Name one exactly.`,
      "TRIGGER_AMBIGUOUS",
    );
  }
  return failed(
    op,
    all.length
      ? `No trigger matched. Active triggers: ${names}. Pass taskId or a displayName fragment.`
      : "No triggers exist.",
    "TRIGGER_NOT_FOUND",
  );
}

function isTriggerOp(value: string): value is TriggerOp {
  return (TRIGGER_OPS as readonly string[]).includes(value);
}

async function opCreate(
  runtime: IAgentRuntime,
  message: Memory,
  params: TriggerParameters,
): Promise<ActionResult> {
  if (triggersDisabled(runtime)) {
    return failed("create", "Triggers are disabled.", "TRIGGERS_OFF");
  }
  // A workflow trigger dispatches a workflow autonomously, so it needs the
  // autonomy loop running. A prompt trigger (reminder) fires through the task
  // scheduler and delivers back to the user's own chat room, so it works with
  // the autonomy loop off — gating reminders on autonomy would make "remind me
  // in N minutes" impossible on a plain chat agent.
  const isWorkflowTrigger = readString(params.workflowId) !== undefined;
  if (isWorkflowTrigger && !runtime.enableAutonomy) {
    return failed("create", "Autonomy is disabled.", "AUTONOMY_OFF");
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
  // Relative delay ("remind me in 90 seconds / 5 minutes"): the natural way a
  // reminder is expressed. Convert to an absolute one-off `scheduledAtIso` so
  // the rest of the create path is unchanged. Explicit scheduledAtIso wins.
  const delayGiven =
    params.delaySeconds !== undefined || params.delayMinutes !== undefined;
  const delayMs = readRelativeDelayMs(params);
  // A delay the model tried to express but we could not parse must fail
  // loudly — silently degrading to the 12-hour default interval turns
  // "remind me in 90 seconds" into a forever-repeating trigger.
  if (delayGiven && delayMs === undefined) {
    return failed(
      "create",
      "delaySeconds/delayMinutes must be a positive whole number.",
      "INVALID_DELAY",
    );
  }
  if (delayMs !== undefined && delayMs > MAX_RELATIVE_DELAY_MS) {
    return failed(
      "create",
      "Relative delay too large; use scheduledAtIso for far-future triggers.",
      "INVALID_DELAY",
    );
  }
  const scheduledFromDelay =
    delayMs !== undefined
      ? new Date(Date.now() + delayMs).toISOString()
      : undefined;
  const scheduledAtIso =
    readString(params.scheduledAtIso) ?? scheduledFromDelay;
  // A relative delay is one-shot by definition; a contradictory explicit
  // triggerType must not silently drop it.
  const triggerType =
    delayMs !== undefined
      ? "once"
      : deriveTriggerType({ ...params, scheduledAtIso });
  const displayName =
    readString(params.displayName) ?? `Trigger: ${instructions.slice(0, 64)}`;
  const wakeMode: TriggerWakeMode =
    params.wakeMode?.trim().toLowerCase() === "next_autonomy_cycle"
      ? "next_autonomy_cycle"
      : "inject_now";
  const creatorId = String(message.entityId);
  const intervalMs = normalizeTriggerIntervalMs(
    parsePositiveInt(params.intervalMs) ?? DEFAULT_INTERVAL_MS,
  );
  const cronExpression = readString(params.cronExpression);
  const maxRuns = parsePositiveInt(params.maxRuns);

  if (triggerType === "once") {
    const atMs = scheduledAtIso ? parseScheduledAtIso(scheduledAtIso) : null;
    // Future-only: a past timestamp produces a task the scheduler considers
    // an invalid repeat — it never fires and never dies. Fail structurally so
    // the model can correct (e.g. recompute a stale timestamp) instead of the
    // user being told "created" about a reminder that will never happen.
    if (atMs === null || atMs <= Date.now()) {
      return failed(
        "create",
        "Once trigger requires a valid future scheduledAtIso.",
        "INVALID_SCHEDULE",
      );
    }
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

  // For delay-derived schedules, hash the RELATIVE delay rather than the
  // absolute timestamp: a planner retry/double-emit of the same tool call
  // lands milliseconds apart and must dedupe to one reminder. Include the
  // workflow target so a prompt reminder and a workflow trigger with the same
  // wording never collide.
  const usedDelay =
    delayMs !== undefined && scheduledAtIso === scheduledFromDelay;
  const scheduleKey = usedDelay ? `+${delayMs}` : (scheduledAtIso ?? "");
  const dedupeKey = dedupeHash(
    `${triggerType}|${instructions.toLowerCase()}|${intervalMs}|${scheduleKey}|${cronExpression ?? ""}|${readString(params.workflowId) ?? ""}`,
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

  // A trigger with a workflowId dispatches that workflow; without one it is a
  // "prompt automation" (a reminder) that injects `instructions` as an agent
  // turn when it fires. Both are first-class TriggerConfig kinds — a reminder
  // is not a degenerate workflow, so we do not require a workflowId here.
  const workflowId = readString(params.workflowId);
  const workflowName = readString(params.workflowName);

  const triggerId = stringToUuid(crypto.randomUUID());
  const triggerBase = {
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
  } as const;
  const triggerConfig: TriggerConfig = workflowId
    ? { ...triggerBase, kind: "workflow", workflowId, workflowName }
    : { ...triggerBase, kind: "prompt" };

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

  // Workflow triggers run autonomously, so they land in the autonomy room. A
  // prompt trigger (reminder) must fire back where the user asked for it — the
  // originating chat room — so the reminder is actually delivered to them.
  const service = runtime.getService(AUTONOMY_SERVICE_TYPE);
  const autonomyService = isAutonomyRoomService(service) ? service : null;
  const roomId =
    triggerConfig.kind === "prompt"
      ? message.roomId
      : (autonomyService?.getAutonomousRoomId?.() ?? message.roomId);

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
      kind: triggerConfig.kind,
      workflowId,
      workflowName,
    },
    { triggerId, taskId, workflowId },
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
  const loaded = await resolveTriggerRef(runtime, "delete", params);
  if ("success" in loaded) return loaded;
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
  const loaded = await resolveTriggerRef(runtime, "run", params);
  if ("success" in loaded) return loaded;
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
  const loaded = await resolveTriggerRef(runtime, "toggle", params);
  if ("success" in loaded) return loaded;
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
  similes: ["REMIND_ME", "SET_REMINDER", "REMINDER", "SCHEDULE_REMINDER"],
  routingHint:
    "reminders, alarms, timers, and one-off or recurring scheduled prompts ('remind me in N minutes / at TIME to …', 'every morning …') -> TRIGGER_CREATE; this IS the reminder/scheduler tool whenever it is exposed. For a relative delay pass delaySeconds or delayMinutes (never a cron expression — cron is for recurring schedules only). Do NOT use TASKS_* (those spawn coding sub-agents) and do NOT declare reminders unavailable because OWNER_REMINDERS is absent.",
  description:
    "Recurring/scheduled trigger lifecycle AND user reminders. Action-based dispatch (create / update / delete / run / toggle). Use create for 'remind me in N minutes/at TIME to …' and any scheduled prompt. Supports relative delay (delaySeconds), a one-off time (scheduledAtIso), interval, and cron.",
  descriptionCompressed:
    "reminders + scheduled prompts: create (remind me in N / at TIME) update delete run toggle (delay|once|interval|cron)",
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

    // Only surface SUCCESS text to the user. A failed op's error already
    // reaches the planner through the ActionResult — posting the raw error
    // ("Cron trigger requires a valid 5-field cron expression.") mid-turn is
    // noise, and the planner usually corrects and succeeds a moment later.
    if (callback && result.success) {
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
        "Trigger task UUID (or triggerId) for update / delete / run / toggle. delete/run/toggle also resolve by displayName fragment when omitted.",
      required: false,
      aliases: ["triggerId", "id"],
      schema: { type: "string" as const },
    },
    {
      name: "delaySeconds",
      description:
        "Fire once after this many seconds from now — THE param for 'remind me in N seconds/minutes' (converted to a one-off schedule; use this or delayMinutes, never cron, for relative delays).",
      required: false,
      aliases: ["inSeconds", "seconds"],
      schema: { type: "number" as const, minimum: 1 },
    },
    {
      name: "delayMinutes",
      description:
        "Fire once after this many minutes from now ('remind me in 5 minutes'). Converted to a one-off schedule.",
      required: false,
      aliases: ["inMinutes", "minutes"],
      schema: { type: "number" as const, minimum: 1 },
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
      description:
        "Trigger display name (create / update). For delete / run / toggle, a name fragment that identifies the trigger.",
      required: false,
      aliases: ["name", "title", "query"],
      schema: { type: "string" as const },
    },
    {
      name: "instructions",
      description: "Trigger instructions (create / update).",
      required: false,
      aliases: ["description", "message", "prompt", "body"],
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
      aliases: ["scheduledFor", "when", "at", "datetime"],
      schema: { type: "string" as const },
    },
    {
      name: "cronExpression",
      description:
        "Five-field cron expression — RECURRING schedules only ('every morning at 9'). Never for a one-off relative delay; use delaySeconds/delayMinutes for 'in N seconds/minutes'.",
      required: false,
      aliases: ["schedule", "cron", "recurrence"],
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
