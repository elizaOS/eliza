/**
 * SCHEDULE — single polymorphic action that consolidates:
 *   - workbench task CRUD            (was MANAGE_TASKS)
 *   - trigger CRUD + run/toggle      (was CREATE_TASK + new ops)
 *   - relationship follow-up         (was SCHEDULE_FOLLOW_UP)
 *   - coding-agent thread lifecycle  (was ARCHIVE/REOPEN_CODING_TASK)
 *
 * The action's `op` parameter selects the sub-handler. No back-compat
 * similes — callers must migrate to SCHEDULE.
 */
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
import { v4 as uuidv4 } from "uuid";
import {
  readTaskMetadata,
  toWorkbenchTask,
  WORKBENCH_TASK_TAG,
} from "../api/workbench-helpers.js";
import {
  buildTriggerMetadata,
  normalizeTriggerIntervalMs,
  parseCronExpression,
  parseScheduledAtIso,
} from "../triggers/scheduling.js";
import type { TriggerTaskMetadata } from "../triggers/types.js";
import {
  executeTriggerTask,
  readTriggerConfig,
  TRIGGER_TASK_NAME,
  TRIGGER_TASK_TAGS,
} from "../triggers/runtime.js";

// Service shapes — duck-typed so this file does not depend on @elizaos/core
// re-exporting the concrete classes (FollowUpService / RelationshipsService
// live in core but are not part of the public package surface).
interface ContactRecord {
  entityId: UUID;
  customFields?: Record<string, unknown>;
}

interface RelationshipsServiceLike {
  searchContacts(criteria: {
    searchTerm?: string;
  }): Promise<ContactRecord[]>;
  getContact(entityId: UUID): Promise<ContactRecord | null>;
}

interface FollowUpServiceLike {
  scheduleFollowUp(
    entityId: UUID,
    scheduledAt: Date,
    reason: string,
    priority?: "high" | "medium" | "low",
    message?: string,
  ): Promise<Task>;
}

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

const SCHEDULE_OPS = [
  "create_task",
  "update_task",
  "complete_task",
  "delete_task",
  "list_tasks",
  "create_trigger",
  "update_trigger",
  "delete_trigger",
  "run_trigger",
  "toggle_trigger",
  "schedule_followup",
  "archive_coding_task",
  "reopen_coding_task",
] as const;

type ScheduleOp = (typeof SCHEDULE_OPS)[number];

const SCHEDULE_ACTION = "SCHEDULE";
const MAX_TRIGGERS_PER_CREATOR = 100;
const DEFAULT_INTERVAL_MS = 12 * 60 * 60 * 1000;

interface ScheduleParameters {
  op?: string;
  // task / trigger fields
  taskId?: string;
  name?: string;
  description?: string;
  // trigger fields
  triggerType?: string;
  displayName?: string;
  instructions?: string;
  wakeMode?: string;
  intervalMs?: string | number;
  scheduledAtIso?: string;
  cronExpression?: string;
  maxRuns?: string | number;
  enabled?: boolean | string;
  // follow-up fields
  contactName?: string;
  entityId?: string;
  scheduledAt?: string;
  reason?: string;
  priority?: string;
  message?: string;
  // coding-task field reuses taskId
}

interface SwarmCoordinatorLike {
  archiveTaskThread?(threadId: string): Promise<void>;
  reopenTaskThread?(threadId: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function readParams(options?: HandlerOptions): ScheduleParameters {
  const raw = options?.parameters;
  if (!raw || typeof raw !== "object") return {};
  return raw as ScheduleParameters;
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
  op: ScheduleOp | string,
  text: string,
  error?: string,
  data?: Record<string, unknown>,
): ActionResult {
  const code = `SCHEDULE_${op.toUpperCase()}_FAILED`;
  return {
    success: false,
    text,
    error: error ?? code,
    values: { op, error: error ?? code },
    data: { actionName: SCHEDULE_ACTION, op, error: error ?? code, ...data },
  };
}

function ok(
  op: ScheduleOp,
  text: string,
  data?: Record<string, unknown>,
  values?: Record<string, unknown>,
): ActionResult {
  return {
    success: true,
    text,
    values: { op, ...(values ?? {}) },
    data: { actionName: SCHEDULE_ACTION, op, ...(data ?? {}) },
  };
}

function deriveTriggerType(p: ScheduleParameters): TriggerType {
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

function getCoordinator(runtime: IAgentRuntime): SwarmCoordinatorLike | null {
  const direct = runtime.getService("SWARM_COORDINATOR") as unknown as
    | SwarmCoordinatorLike
    | null;
  if (direct) return direct;
  const pty = runtime.getService("PTY_SERVICE") as unknown as
    | { coordinator?: SwarmCoordinatorLike }
    | null;
  return pty?.coordinator ?? null;
}

// ─────────────────────────────────────────────────────────────
// Op handlers
// ─────────────────────────────────────────────────────────────

async function opCreateTask(
  runtime: IAgentRuntime,
  message: Memory,
  params: ScheduleParameters,
): Promise<ActionResult> {
  const name =
    readString(params.name) ??
    readString(params.description) ??
    readString(message.content.text)?.slice(0, 100);
  if (!name) {
    return failed("create_task", "Task name is required.", "MISSING_NAME");
  }
  const description = readString(params.description) ?? "";
  const taskId = await runtime.createTask({
    name,
    description,
    tags: [WORKBENCH_TASK_TAG],
    metadata: { isCompleted: false, workbench: { kind: "task" } },
  });
  return ok(
    "create_task",
    `Created task "${name}".`,
    { taskId: String(taskId) },
    { taskId: String(taskId) },
  );
}

async function opUpdateTask(
  runtime: IAgentRuntime,
  params: ScheduleParameters,
): Promise<ActionResult> {
  const taskId = readUuid(params.taskId);
  if (!taskId)
    return failed("update_task", "taskId is required.", "MISSING_TASK_ID");
  const task = await runtime.getTask(taskId);
  if (!task?.id)
    return failed("update_task", `Task not found: ${taskId}`, "TASK_NOT_FOUND");
  const update: Partial<Task> = {};
  const name = readString(params.name);
  const description = readString(params.description);
  if (name) update.name = name;
  if (description !== undefined) update.description = description;
  if (Object.keys(update).length === 0) {
    return failed("update_task", "No updatable fields supplied.", "NO_FIELDS");
  }
  await runtime.updateTask(task.id, update);
  return ok("update_task", `Updated task "${name ?? task.name}".`, {
    taskId: String(task.id),
  });
}

async function opCompleteTask(
  runtime: IAgentRuntime,
  params: ScheduleParameters,
): Promise<ActionResult> {
  const taskId = readUuid(params.taskId);
  if (!taskId)
    return failed("complete_task", "taskId is required.", "MISSING_TASK_ID");
  const task = await runtime.getTask(taskId);
  if (!task?.id)
    return failed(
      "complete_task",
      `Task not found: ${taskId}`,
      "TASK_NOT_FOUND",
    );
  const metadata = readTaskMetadata(task);
  await runtime.updateTask(task.id, {
    metadata: { ...metadata, isCompleted: true },
  });
  return ok("complete_task", `Completed task "${task.name}".`, {
    taskId: String(task.id),
  });
}

async function opDeleteTask(
  runtime: IAgentRuntime,
  params: ScheduleParameters,
): Promise<ActionResult> {
  const taskId = readUuid(params.taskId);
  if (!taskId)
    return failed("delete_task", "taskId is required.", "MISSING_TASK_ID");
  const task = await runtime.getTask(taskId);
  if (!task?.id)
    return failed("delete_task", `Task not found: ${taskId}`, "TASK_NOT_FOUND");
  await runtime.deleteTask(task.id);
  return ok("delete_task", `Deleted task "${task.name}".`, {
    taskId: String(task.id),
  });
}

async function opListTasks(runtime: IAgentRuntime): Promise<ActionResult> {
  const allTasks = await runtime.getTasks({ agentIds: [runtime.agentId] });
  const workbenchTasks = allTasks.filter(
    (t) => !readTriggerConfig(t) && toWorkbenchTask(t) !== null,
  );
  if (workbenchTasks.length === 0) {
    return ok("list_tasks", "You have no tasks right now.", { tasks: [] });
  }
  const lines = workbenchTasks.map((t) => {
    const meta = readTaskMetadata(t);
    const done = meta.isCompleted === true;
    const desc = t.description ? ` — ${t.description}` : "";
    return `${done ? "✓" : "○"} ${t.name}${desc}`;
  });
  return ok(
    "list_tasks",
    `Your tasks:\n${lines.join("\n")}`,
    {
      tasks: workbenchTasks.map((t) => ({
        id: t.id ?? "",
        name: t.name,
        description: t.description ?? "",
        isCompleted: readTaskMetadata(t).isCompleted === true,
      })),
    },
  );
}

async function opCreateTrigger(
  runtime: IAgentRuntime,
  message: Memory,
  params: ScheduleParameters,
): Promise<ActionResult> {
  if (!runtime.enableAutonomy) {
    return failed("create_trigger", "Autonomy is disabled.", "AUTONOMY_OFF");
  }
  if (triggersDisabled(runtime)) {
    return failed("create_trigger", "Triggers are disabled.", "TRIGGERS_OFF");
  }
  const text = readString(message.content.text) ?? "";
  const instructions = readString(params.instructions) ?? text;
  if (!instructions) {
    return failed(
      "create_trigger",
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
      "create_trigger",
      "Once trigger requires a valid scheduledAtIso.",
      "INVALID_SCHEDULE",
    );
  }
  if (
    triggerType === "cron" &&
    (!cronExpression || !parseCronExpression(cronExpression))
  ) {
    return failed(
      "create_trigger",
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
      "create_trigger",
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
    return ok(
      "create_trigger",
      "An equivalent trigger already exists.",
      { duplicateTaskId: duplicate.id, dedupeKey },
    );
  }

  const triggerId = stringToUuid(uuidv4());
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
  };

  const metadata = buildTriggerMetadata({
    trigger: triggerConfig,
    nowMs: Date.now(),
  });
  if (!metadata) {
    return failed(
      "create_trigger",
      "Failed to compute trigger schedule.",
      "SCHEDULE_COMPUTE_FAILED",
    );
  }

  const autonomyService = runtime.getService("AUTONOMY") as unknown as {
    getAutonomousRoomId?(): UUID;
  } | null;
  const roomId = autonomyService?.getAutonomousRoomId?.() ?? message.roomId;

  const taskId = await runtime.createTask({
    name: TRIGGER_TASK_NAME,
    description: displayName,
    roomId,
    tags: [...TRIGGER_TASK_TAGS],
    metadata,
  });

  return ok(
    "create_trigger",
    `Created trigger "${displayName}" (${describeSchedule(triggerConfig)}).`,
    { triggerId, taskId, triggerType, wakeMode, dedupeKey },
    { triggerId, taskId },
  );
}

async function opUpdateTrigger(
  runtime: IAgentRuntime,
  params: ScheduleParameters,
): Promise<ActionResult> {
  const taskId = readUuid(params.taskId);
  if (!taskId)
    return failed("update_trigger", "taskId is required.", "MISSING_TASK_ID");
  const loaded = await loadTriggerTask(runtime, taskId);
  if (!loaded)
    return failed(
      "update_trigger",
      `Trigger task not found: ${taskId}`,
      "TRIGGER_NOT_FOUND",
    );
  const { task, trigger } = loaded;
  if (!task.id)
    return failed("update_trigger", "Task missing id.", "TASK_NOT_FOUND");

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
      return failed(
        "update_trigger",
        "Invalid scheduledAtIso.",
        "INVALID_SCHEDULE",
      );
    }
    next.scheduledAtIso = scheduledAtIso;
  }
  if (cronExpression !== undefined && next.triggerType === "cron") {
    if (!parseCronExpression(cronExpression)) {
      return failed("update_trigger", "Invalid cron expression.", "INVALID_CRON");
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
      "update_trigger",
      "Failed to recompute trigger schedule.",
      "SCHEDULE_COMPUTE_FAILED",
    );
  }
  await runtime.updateTask(task.id, {
    description: next.displayName,
    metadata,
  });
  return ok(
    "update_trigger",
    `Updated trigger "${next.displayName}".`,
    { taskId: String(task.id), triggerId: next.triggerId },
  );
}

async function opDeleteTrigger(
  runtime: IAgentRuntime,
  params: ScheduleParameters,
): Promise<ActionResult> {
  const taskId = readUuid(params.taskId);
  if (!taskId)
    return failed("delete_trigger", "taskId is required.", "MISSING_TASK_ID");
  const loaded = await loadTriggerTask(runtime, taskId);
  if (!loaded)
    return failed(
      "delete_trigger",
      `Trigger task not found: ${taskId}`,
      "TRIGGER_NOT_FOUND",
    );
  if (!loaded.task.id)
    return failed("delete_trigger", "Task missing id.", "TASK_NOT_FOUND");
  await runtime.deleteTask(loaded.task.id);
  return ok("delete_trigger", `Deleted trigger "${loaded.trigger.displayName}".`, {
    taskId: String(loaded.task.id),
  });
}

async function opRunTrigger(
  runtime: IAgentRuntime,
  params: ScheduleParameters,
): Promise<ActionResult> {
  const taskId = readUuid(params.taskId);
  if (!taskId)
    return failed("run_trigger", "taskId is required.", "MISSING_TASK_ID");
  const loaded = await loadTriggerTask(runtime, taskId);
  if (!loaded)
    return failed(
      "run_trigger",
      `Trigger task not found: ${taskId}`,
      "TRIGGER_NOT_FOUND",
    );
  const result = await executeTriggerTask(runtime, loaded.task, {
    source: "manual",
    force: true,
  });
  if (result.status === "error") {
    return failed(
      "run_trigger",
      `Trigger run failed: ${result.error ?? "unknown error"}`,
      "RUN_FAILED",
      { triggerId: loaded.trigger.triggerId },
    );
  }
  return ok(
    "run_trigger",
    `Ran trigger "${loaded.trigger.displayName}".`,
    {
      taskId: String(loaded.task.id),
      triggerId: loaded.trigger.triggerId,
      status: result.status,
      taskDeleted: result.taskDeleted,
    },
  );
}

async function opToggleTrigger(
  runtime: IAgentRuntime,
  params: ScheduleParameters,
): Promise<ActionResult> {
  const taskId = readUuid(params.taskId);
  if (!taskId)
    return failed("toggle_trigger", "taskId is required.", "MISSING_TASK_ID");
  const loaded = await loadTriggerTask(runtime, taskId);
  if (!loaded)
    return failed(
      "toggle_trigger",
      `Trigger task not found: ${taskId}`,
      "TRIGGER_NOT_FOUND",
    );
  const { task, trigger } = loaded;
  if (!task.id)
    return failed("toggle_trigger", "Task missing id.", "TASK_NOT_FOUND");
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
      "toggle_trigger",
      "Failed to recompute trigger schedule.",
      "SCHEDULE_COMPUTE_FAILED",
    );
  }
  await runtime.updateTask(task.id, { metadata });
  return ok(
    "toggle_trigger",
    `${enabled ? "Enabled" : "Disabled"} trigger "${trigger.displayName}".`,
    { taskId: String(task.id), triggerId: trigger.triggerId, enabled },
  );
}

async function opScheduleFollowUp(
  runtime: IAgentRuntime,
  params: ScheduleParameters,
): Promise<ActionResult> {
  const relationships = runtime.getService(
    "relationships",
  ) as unknown as RelationshipsServiceLike | null;
  const followUpService = runtime.getService(
    "follow_up",
  ) as unknown as FollowUpServiceLike | null;
  if (!relationships || !followUpService) {
    return failed(
      "schedule_followup",
      "Follow-up scheduling is unavailable.",
      "SERVICE_UNAVAILABLE",
    );
  }
  const scheduledAtRaw = readString(params.scheduledAt);
  if (!scheduledAtRaw) {
    return failed(
      "schedule_followup",
      "scheduledAt is required.",
      "MISSING_SCHEDULED_AT",
    );
  }
  const scheduledAt = new Date(scheduledAtRaw);
  if (Number.isNaN(scheduledAt.getTime())) {
    return failed(
      "schedule_followup",
      "Invalid scheduledAt.",
      "INVALID_SCHEDULED_AT",
    );
  }

  let entityId: UUID | null = readUuid(params.entityId) ?? null;
  const contactName = readString(params.contactName);
  if (!entityId && contactName) {
    const contacts = await relationships.searchContacts({
      searchTerm: contactName,
    });
    entityId = contacts[0]?.entityId ?? null;
    if (!entityId) {
      return failed(
        "schedule_followup",
        `Contact "${contactName}" not found.`,
        "CONTACT_NOT_FOUND",
        { contactName },
      );
    }
  }
  if (!entityId) {
    return failed(
      "schedule_followup",
      "contactName or entityId is required.",
      "MISSING_CONTACT",
    );
  }
  const contact = await relationships.getContact(entityId);
  if (!contact) {
    return failed(
      "schedule_followup",
      "Contact not found in relationships.",
      "CONTACT_NOT_FOUND",
      { entityId: String(entityId) },
    );
  }

  const reason = readString(params.reason) ?? "Follow-up";
  const priorityRaw = readString(params.priority)?.toLowerCase();
  const priority: "high" | "medium" | "low" =
    priorityRaw === "high" || priorityRaw === "low" ? priorityRaw : "medium";
  const messageText = readString(params.message);

  const task = await followUpService.scheduleFollowUp(
    entityId,
    scheduledAt,
    reason,
    priority,
    messageText,
  );

  return ok(
    "schedule_followup",
    `Scheduled follow-up with ${contactName ?? "contact"} for ${scheduledAt.toLocaleString()}.`,
    {
      contactId: String(entityId),
      contactName: contactName ?? "",
      scheduledAt: scheduledAt.toISOString(),
      taskId: task.id ?? "",
      reason,
      priority,
    },
    { contactId: String(entityId), taskId: task.id ?? "" },
  );
}

async function opArchiveCodingTask(
  runtime: IAgentRuntime,
  params: ScheduleParameters,
): Promise<ActionResult> {
  const taskId = readString(params.taskId);
  if (!taskId)
    return failed(
      "archive_coding_task",
      "taskId is required.",
      "MISSING_TASK_ID",
    );
  const coordinator = getCoordinator(runtime);
  if (!coordinator?.archiveTaskThread) {
    return failed(
      "archive_coding_task",
      "Swarm coordinator unavailable.",
      "COORDINATOR_UNAVAILABLE",
    );
  }
  await coordinator.archiveTaskThread(taskId);
  return ok("archive_coding_task", `Archived coding task ${taskId}.`, {
    taskId,
  });
}

async function opReopenCodingTask(
  runtime: IAgentRuntime,
  params: ScheduleParameters,
): Promise<ActionResult> {
  const taskId = readString(params.taskId);
  if (!taskId)
    return failed(
      "reopen_coding_task",
      "taskId is required.",
      "MISSING_TASK_ID",
    );
  const coordinator = getCoordinator(runtime);
  if (!coordinator?.reopenTaskThread) {
    return failed(
      "reopen_coding_task",
      "Swarm coordinator unavailable.",
      "COORDINATOR_UNAVAILABLE",
    );
  }
  await coordinator.reopenTaskThread(taskId);
  return ok("reopen_coding_task", `Reopened coding task ${taskId}.`, { taskId });
}

// ─────────────────────────────────────────────────────────────
// Action
// ─────────────────────────────────────────────────────────────

function isScheduleOp(value: string): value is ScheduleOp {
  return (SCHEDULE_OPS as readonly string[]).includes(value);
}

export const scheduleAction: Action = {
  name: SCHEDULE_ACTION,
  contexts: ["tasks", "automation", "calendar", "contacts", "code", "agent_internal"],
  roleGate: { minRole: "ADMIN" },
  similes: [],
  description:
    "Polymorphic scheduler: workbench task CRUD, trigger CRUD/run/toggle, contact follow-up, and coding-task archive/reopen. Select sub-action via the `op` parameter.",
  descriptionCompressed:
    "polymorphic schedule task trigger followup coding-archive op-dispatch",
  suppressPostActionContinuation: true,

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions,
  ): Promise<boolean> => {
    const op = readString(readParams(options).op);
    return op !== undefined && isScheduleOp(op);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = readParams(options);
    const opRaw = readString(params.op)?.toLowerCase();
    if (!opRaw || !isScheduleOp(opRaw)) {
      const result = failed(
        "invalid",
        `Invalid op. Expected one of: ${SCHEDULE_OPS.join(", ")}.`,
        "SCHEDULE_INVALID_OP",
      );
      if (callback) {
        await callback({ text: result.text ?? "", action: SCHEDULE_ACTION });
      }
      return result;
    }
    const op: ScheduleOp = opRaw;

    let result: ActionResult;
    switch (op) {
      case "create_task":
        result = await opCreateTask(runtime, message, params);
        break;
      case "update_task":
        result = await opUpdateTask(runtime, params);
        break;
      case "complete_task":
        result = await opCompleteTask(runtime, params);
        break;
      case "delete_task":
        result = await opDeleteTask(runtime, params);
        break;
      case "list_tasks":
        result = await opListTasks(runtime);
        break;
      case "create_trigger":
        result = await opCreateTrigger(runtime, message, params);
        break;
      case "update_trigger":
        result = await opUpdateTrigger(runtime, params);
        break;
      case "delete_trigger":
        result = await opDeleteTrigger(runtime, params);
        break;
      case "run_trigger":
        result = await opRunTrigger(runtime, params);
        break;
      case "toggle_trigger":
        result = await opToggleTrigger(runtime, params);
        break;
      case "schedule_followup":
        result = await opScheduleFollowUp(runtime, params);
        break;
      case "archive_coding_task":
        result = await opArchiveCodingTask(runtime, params);
        break;
      case "reopen_coding_task":
        result = await opReopenCodingTask(runtime, params);
        break;
    }

    if (callback) {
      await callback({
        text: result.text ?? "",
        action: SCHEDULE_ACTION,
        metadata: { op, ...(result.values ?? {}) },
      });
    }
    return result;
  },

  parameters: [
    {
      name: "op",
      description: `Sub-action to dispatch. One of: ${SCHEDULE_OPS.join(", ")}.`,
      required: true,
      schema: { type: "string" as const, enum: [...SCHEDULE_OPS] },
    },
    {
      name: "taskId",
      description:
        "Target task UUID. Required for update/complete/delete/list-related task ops, trigger update/delete/run/toggle, archive/reopen coding-task.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "name",
      description: "Workbench task name (create_task / update_task).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "description",
      description: "Workbench task description (create_task / update_task).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "triggerType",
      description: "Trigger schedule type for create_trigger.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["interval", "once", "cron"],
      },
    },
    {
      name: "displayName",
      description: "Trigger display name (create_trigger / update_trigger).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "instructions",
      description: "Trigger instructions (create_trigger / update_trigger).",
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
      description: "Enable or disable a trigger (toggle_trigger).",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "contactName",
      description: "Contact name for schedule_followup.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "entityId",
      description: "Contact entityId for schedule_followup.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "scheduledAt",
      description: "ISO date/time for schedule_followup.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "reason",
      description: "Reason for schedule_followup.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "priority",
      description: "Priority for schedule_followup.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["high", "medium", "low"],
      },
    },
    {
      name: "message",
      description: "Optional message text for schedule_followup.",
      required: false,
      schema: { type: "string" as const },
    },
  ],

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Add a todo to buy groceries tomorrow." },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'Created task "buy groceries tomorrow".',
          action: SCHEDULE_ACTION,
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "Create a trigger every 12 hours to review open PRs." },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'Created trigger "Trigger: review open PRs" (every 43200000ms).',
          action: SCHEDULE_ACTION,
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "Schedule a follow-up with Alice next Monday at 10am." },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Scheduled follow-up with Alice for Monday 10:00 AM.",
          action: SCHEDULE_ACTION,
        },
      },
    ],
  ] as ActionExample[][],
};

export { SCHEDULE_OPS };
