/**
 * TRIGGER — recurring/scheduled trigger lifecycle as a Pattern-C op-dispatch
 * action.
 *
 * Ops:
 *   create — create a trigger (interval / once / cron) with instructions and
 *            wakeMode. Enforces a per-creator limit and dedupes on the full
 *            delivery identity (type, instructions, schedule, workflow,
 *            creator, delivery room).
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
  type EffectReceipt,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  resolveMessageTimeZone,
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
  describeCronSchedule,
  describeIntervalMs,
  describeOnceAt,
} from "../triggers/humanize.ts";
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
  const normalized = readString(value);
  return normalized ? (validateUuid(normalized) ?? undefined) : undefined;
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

// TRIGGER never emits a mid-turn callback (see the handler note below), and
// every committed mutation opts into `turnComplete`, so the action's own
// humanized ack is the single user-facing message for a single-op turn — and
// the planned-reply egress gate refuses any completion claim not bound to a
// committed effect receipt with exact action-owned text. Every mutating op
// therefore returns the full receipt contract; a bare {success,text} result
// made even a genuine "reminder is set" ack structurally unverifiable, so it
// was replaced with the unverified-effect fallback at egress.
//
// The receiptId carries a random component: the planner can re-dispatch the
// identical create within one turn (both invocations landing on the dedupe
// path), and the turn-wide receipt merge rejects a reused ID whose observed
// timestamp differs.
function triggerReceipt(
  op: "create" | "update" | "delete" | "toggle",
  taskId: string,
  idempotency: { key: string | null; replayed?: boolean },
): EffectReceipt {
  const observedAt = new Date().toISOString();
  const base = {
    receiptId: `trigger-${op}:${taskId}:${crypto.randomUUID()}`,
    operation: `trigger.${op}`,
    resource: { kind: "trigger.task", id: taskId },
    artifacts: [],
    idempotency: {
      key: idempotency.key,
      replayed: idempotency.replayed === true,
    },
    observedAt,
  } as const;
  // A replay means the handler verified an equivalent committed trigger row
  // already exists — the documented replayed-noop semantics — rather than a
  // fresh commit of a new row.
  return idempotency.replayed
    ? {
        ...base,
        outcome: "noop",
        reason: "An equivalent enabled trigger already exists.",
      }
    : {
        ...base,
        outcome: "applied",
        commit: { kind: "durable", id: taskId, committedAt: observedAt },
      };
}

// Committed-mutation result: binds the canonical text to its receipt so the
// egress verifier can ground a completion claim on it. `turnComplete` makes
// this ack the turn's single user-facing message when the op was the turn's
// sole tool — without it the planner-loop combines the verified text with the
// evaluator's prose, double-speaking the same fact ("Created trigger … . on
// it. set for 8am every morning." observed live).
function okCommitted(
  op: TriggerOp,
  text: string,
  receipt: EffectReceipt,
  data?: Record<string, unknown>,
  values?: Record<string, unknown>,
): ActionResult {
  return {
    ...ok(op, text, data, values),
    userFacingText: text,
    verifiedUserFacing: true,
    turnComplete: true,
    effectReceipts: [receipt],
    userFacingEffectReceiptIds: [receipt.receiptId],
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

function normalizeCronDedupeExpression(expression: string): string {
  return expression.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildTriggerDedupeKey(input: {
  triggerType: TriggerType;
  instructions: string;
  scheduleKey: string;
  workflowId?: string;
  creatorId: string;
  deliveryRoomId: UUID;
}): string {
  return dedupeHash(
    `${input.triggerType}|${input.instructions.toLowerCase()}|${input.scheduleKey}|${input.workflowId ?? ""}|${input.creatorId}|${input.deliveryRoomId}`,
  );
}

function persistedScheduleDedupeKey(trigger: TriggerConfig): string {
  if (trigger.triggerType === "once") {
    return trigger.scheduledAtIso ?? "";
  }
  if (trigger.triggerType === "interval") {
    return `every:${trigger.intervalMs ?? ""}`;
  }
  return `cron:${normalizeCronDedupeExpression(trigger.cronExpression ?? "")}@${trigger.timezone ?? ""}`;
}

// Chat-facing schedule phrasing. The raw forms (ISO timestamp, cron
// expression, interval milliseconds) are machine detail: they stay in the
// ActionResult's `data`, never in user text. Unrecognized shapes degrade to a
// neutral phrase rather than echoing the raw value.
function describeSchedule(
  t: TriggerConfig,
  messageTimeZone: string,
  nowMs = Date.now(),
): string {
  if (t.triggerType === "interval") {
    return (
      describeIntervalMs(t.intervalMs ?? DEFAULT_INTERVAL_MS) ??
      "on a custom schedule"
    );
  }
  if (t.triggerType === "once") {
    const friendly = t.scheduledAtIso
      ? describeOnceAt(t.scheduledAtIso, nowMs, messageTimeZone)
      : null;
    return friendly ?? "soon";
  }
  if (!t.timezone || t.timezone !== messageTimeZone) {
    return "on its saved recurring schedule";
  }
  const friendly = t.cronExpression
    ? describeCronSchedule(t.cronExpression)
    : null;
  return friendly ?? "on a custom schedule";
}

// The stored displayName defaults to "Trigger: <instructions>" — an internal
// naming convention, not something to read back at the user.
function displayLabel(name: string): string {
  const stripped = name.replace(/^trigger:\s*/i, "").trim();
  return stripped.length > 0 ? stripped : name;
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
  const querySource =
    readString(params.displayName) ?? readString(params.instructions);
  const query = querySource?.toLowerCase().replace(/^trigger:\s*/, "");

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
  // Recurrence resolves FIRST: a field-spraying planner answering "remind me
  // every morning at 9am" emits the cron AND its derived one-shot echoes —
  // delayMinutes/delaySeconds/scheduledAtIso computed as the time to the
  // FIRST fire. Letting those one-shot fields outrank the recurrence payload
  // silently downgraded "every morning" to a single reminder. Only an
  // explicit one-shot/interval `triggerType` — a typed statement, not a
  // sprayed number — outranks a provided cronExpression.
  const explicitType = params.triggerType?.trim().toLowerCase();
  const cronExpression = readString(params.cronExpression);
  const explicitScheduledAtIso = readString(params.scheduledAtIso);
  const wantsCron =
    explicitType === "cron" ||
    (cronExpression !== undefined &&
      explicitType !== "once" &&
      explicitType !== "interval");
  // Relative delay ("remind me in 90 seconds / 5 minutes"): the natural way a
  // one-off reminder is expressed. Convert to an absolute one-off
  // `scheduledAtIso` so the rest of the create path is unchanged. Explicit
  // scheduledAtIso wins. Under a cron schedule the delay fields are ignored
  // entirely — they are first-fire echoes, not a schedule — so a junk delay
  // cannot block a valid recurring create.
  const hasDelayInput =
    params.delaySeconds !== undefined || params.delayMinutes !== undefined;
  const parsedDelayMs =
    wantsCron || explicitScheduledAtIso !== undefined
      ? undefined
      : readRelativeDelayMs(params);
  const delayGiven =
    !wantsCron &&
    explicitScheduledAtIso === undefined &&
    hasDelayInput &&
    !(explicitType === "interval" && parsedDelayMs === undefined);
  const delayMs = parsedDelayMs;
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
  const scheduledAtIso = explicitScheduledAtIso ?? scheduledFromDelay;
  // A relative delay is one-shot by definition; a contradictory explicit
  // triggerType (e.g. "interval") must not silently drop it. Cron resolved
  // above, so a delay can no longer demote a recurring schedule to one-shot.
  const triggerType: TriggerType = wantsCron
    ? "cron"
    : delayMs !== undefined
      ? "once"
      : deriveTriggerType({ ...params, scheduledAtIso });
  const displayName =
    readString(params.displayName) ?? `Trigger: ${instructions.slice(0, 64)}`;
  const wakeMode: TriggerWakeMode =
    params.wakeMode?.trim().toLowerCase() === "next_autonomy_cycle"
      ? "next_autonomy_cycle"
      : "inject_now";
  const creatorId = String(message.entityId);
  const messageTimeZone = resolveMessageTimeZone(runtime, message);
  const parsedIntervalMs = parsePositiveInt(params.intervalMs);
  if (
    triggerType === "interval" &&
    params.intervalMs !== undefined &&
    parsedIntervalMs === undefined
  ) {
    return failed(
      "create",
      "intervalMs must be a positive whole number.",
      "INVALID_INTERVAL",
    );
  }
  const intervalMs = normalizeTriggerIntervalMs(
    parsedIntervalMs ?? DEFAULT_INTERVAL_MS,
  );
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
  // The schedule identity is built from the RESOLVED type's own field only:
  // once -> fire time, interval -> normalized interval, cron -> normalized
  // expression. Fields the resolution IGNORED (a sprayed first-fire timestamp
  // on a cron, a sprayed intervalMs alongside a cron, a sprayed cron alongside
  // an explicit once/interval) must not leak into the key — a field-spraying
  // planner emits them inconsistently across retries, so hashing them turns
  // the same "every morning" ask into a "new" trigger instead of a replayed
  // no-op.
  const scheduleKey =
    triggerType === "once"
      ? usedDelay
        ? `+${delayMs}`
        : (scheduledAtIso ?? "")
      : triggerType === "interval"
        ? `every:${intervalMs}`
        : `cron:${normalizeCronDedupeExpression(cronExpression ?? "")}@${messageTimeZone}`;
  const workflowId = readString(params.workflowId);
  const dedupeWorkflowId = workflowId === undefined ? "" : workflowId;
  // Workflow triggers run autonomously, so they land in the autonomy room. A
  // prompt trigger (reminder) must fire back where the user asked for it — the
  // originating chat room — so the reminder is actually delivered to them.
  // Resolved before the dedupe key because the delivery room is part of the
  // trigger's identity.
  const service = runtime.getService(AUTONOMY_SERVICE_TYPE);
  const autonomyService = isAutonomyRoomService(service) ? service : null;
  const deliveryRoomId = workflowId
    ? (autonomyService?.getAutonomousRoomId?.() ?? message.roomId)
    : message.roomId;
  // The dedupe key is the COMPLETE delivery identity: what fires (type,
  // instructions, schedule, workflow) plus who it fires FOR (creator) and
  // WHERE it fires (delivery room). Task lookup is agent-wide, so a key
  // hashing only the request let one user's stored reminder suppress a
  // different user's identical ask — the second recipient got a verified
  // "you're covered" while the only existing trigger delivered to someone
  // else's room. Only the same recipient re-asking for the same delivery is
  // a replay.
  const dedupeKey = buildTriggerDedupeKey({
    triggerType,
    instructions,
    scheduleKey,
    workflowId: dedupeWorkflowId,
    creatorId,
    deliveryRoomId,
  });

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

  // Two duplicate tiers with different evidentiary strength. A dedupeKey
  // match hashes the FULL request (type, instructions, schedule, workflow),
  // so it proves the desired state is already true and may mint a replayed
  // receipt. The legacy fallback matches instructions+type only — it ignores
  // the schedule, so a stored 8am reminder "matches" a new 9am request; that
  // is a hint, never proof, and must not become a verified "you're covered".
  // The createdBy equality is load-bearing even though the key already hashes
  // the creator: dedupeHash is a 32-bit djb2, so a collision across users is
  // possible — and a cross-recipient false match here silently swallows a
  // distinct recipient's delivery. The structural guard makes that class of
  // suppression impossible regardless of hash width.
  const exactDuplicate = existingTasks.find((t) => {
    const cfg = readTriggerConfig(t);
    return Boolean(
      cfg?.enabled &&
        cfg.createdBy === creatorId &&
        cfg.dedupeKey === dedupeKey,
    );
  });
  if (exactDuplicate?.id) {
    // Idempotent success: the desired state (an equivalent enabled trigger)
    // is already committed. The replayed no-op receipt lets a truthful
    // "you're already covered" ack pass egress verification.
    return okCommitted(
      "create",
      // Human phrasing: the user's goal is already true, so say that plainly
      // rather than narrating the dedupe machinery ("an equivalent trigger
      // exists" reads as an internal record, not an answer).
      "Already set — you're covered.",
      triggerReceipt("create", String(exactDuplicate.id), {
        key: dedupeKey,
        replayed: true,
      }),
      { duplicateTaskId: exactDuplicate.id, dedupeKey },
    );
  }
  const legacyDuplicate = existingTasks.find((t) => {
    const cfg = readTriggerConfig(t);
    if (!cfg?.enabled || cfg.dedupeKey) return false;
    // Same recipient only: another user's identical wording is a different
    // delivery, not a near-duplicate — steering them to "delete it first"
    // would suppress their own reminder in favor of someone else's.
    if (cfg.createdBy !== creatorId) return false;
    return (
      cfg.instructions.trim().toLowerCase() === instructions.toLowerCase() &&
      cfg.triggerType === triggerType
    );
  });
  if (legacyDuplicate?.id) {
    // Un-receipted: the fuzzy match cannot prove the schedule matches, so
    // this reports the near-duplicate without claiming verified success.
    return ok(
      "create",
      `A similar ${triggerType} trigger already exists ("${readTriggerConfig(legacyDuplicate)?.instructions ?? "unknown"}"). Confirm whether that covers this, or delete it first to create the new one.`,
      { duplicateTaskId: legacyDuplicate.id, legacyFuzzyMatch: true },
    );
  }

  // A trigger with a workflowId dispatches that workflow; without one it is a
  // "prompt automation" (a reminder) that injects `instructions` as an agent
  // turn when it fires. Both are first-class TriggerConfig kinds — a reminder
  // is not a degenerate workflow, so we do not require a workflowId here.
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
    notifyOnOutcome: true,
    timezone: messageTimeZone,
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

  const taskId = await runtime.createTask({
    name: TRIGGER_TASK_NAME,
    description: displayName,
    // The room hashed into the dedupe key above — the task must land exactly
    // where its identity says it delivers.
    roomId: deliveryRoomId,
    tags: [...TRIGGER_TASK_TAGS],
    metadata,
  });

  // A prompt trigger IS a reminder to the person who asked for it; a workflow
  // trigger is a scheduled job. Either way the schedule reads as a human
  // phrase — the machine forms live in `data` below.
  const schedule = describeSchedule(triggerConfig, messageTimeZone);
  const label = displayLabel(displayName);
  return okCommitted(
    "create",
    triggerConfig.kind === "workflow"
      ? `Scheduled "${label}" — ${schedule}.`
      : `Reminder set: "${label}" — ${schedule}.`,
    triggerReceipt("create", String(taskId), { key: dedupeKey }),
    {
      triggerId,
      taskId,
      triggerType,
      wakeMode,
      dedupeKey,
      kind: triggerConfig.kind,
      workflowId,
      workflowName,
      scheduledAtIso: triggerConfig.scheduledAtIso,
      cronExpression: triggerConfig.cronExpression,
      intervalMs: triggerConfig.intervalMs,
      timezone: triggerConfig.timezone,
    },
    { triggerId, taskId, workflowId },
  );
}

async function opUpdate(
  runtime: IAgentRuntime,
  message: Memory,
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
  const messageTimeZone = resolveMessageTimeZone(runtime, message);

  const next: TriggerConfig = { ...trigger };
  const displayName = readString(params.displayName);
  const instructions = readString(params.instructions);
  const intervalMs = parsePositiveInt(params.intervalMs);
  const scheduledAtIso = readString(params.scheduledAtIso);
  const cronExpression = readString(params.cronExpression);
  const maxRuns = parsePositiveInt(params.maxRuns);
  const wakeModeRaw = params.wakeMode?.trim().toLowerCase();
  let dedupeIdentityChanged = false;

  if (displayName) next.displayName = displayName;
  if (instructions) {
    dedupeIdentityChanged =
      dedupeIdentityChanged ||
      instructions.toLowerCase() !== trigger.instructions.toLowerCase();
    next.instructions = instructions;
  }
  if (intervalMs !== undefined && next.triggerType === "interval") {
    const normalizedIntervalMs = normalizeTriggerIntervalMs(intervalMs);
    dedupeIdentityChanged =
      dedupeIdentityChanged || normalizedIntervalMs !== trigger.intervalMs;
    next.intervalMs = normalizedIntervalMs;
  }
  if (scheduledAtIso !== undefined && next.triggerType === "once") {
    if (parseScheduledAtIso(scheduledAtIso) === null) {
      return failed("update", "Invalid scheduledAtIso.", "INVALID_SCHEDULE");
    }
    dedupeIdentityChanged =
      dedupeIdentityChanged || scheduledAtIso !== trigger.scheduledAtIso;
    next.scheduledAtIso = scheduledAtIso;
  }
  if (cronExpression !== undefined && next.triggerType === "cron") {
    if (!parseCronExpression(cronExpression)) {
      return failed("update", "Invalid cron expression.", "INVALID_CRON");
    }
    dedupeIdentityChanged =
      dedupeIdentityChanged ||
      normalizeCronDedupeExpression(cronExpression) !==
        normalizeCronDedupeExpression(trigger.cronExpression ?? "") ||
      messageTimeZone !== trigger.timezone;
    next.cronExpression = cronExpression;
    next.timezone = messageTimeZone;
  }
  if (maxRuns !== undefined) next.maxRuns = maxRuns;
  if (wakeModeRaw === "inject_now" || wakeModeRaw === "next_autonomy_cycle") {
    next.wakeMode = wakeModeRaw;
  }

  if (dedupeIdentityChanged) {
    if (!task.roomId) {
      return failed(
        "update",
        "Trigger task is missing its delivery room.",
        "TRIGGER_ROOM_MISSING",
      );
    }
    next.dedupeKey = buildTriggerDedupeKey({
      triggerType: next.triggerType,
      instructions: next.instructions,
      scheduleKey: persistedScheduleDedupeKey(next),
      workflowId: next.kind === "workflow" ? next.workflowId : undefined,
      creatorId: next.createdBy,
      deliveryRoomId: task.roomId,
    });
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
  return okCommitted(
    "update",
    `Updated "${displayLabel(next.displayName)}" — ${describeSchedule(
      next,
      messageTimeZone,
    )}.`,
    triggerReceipt("update", String(task.id), { key: null }),
    {
      taskId: String(task.id),
      triggerId: next.triggerId,
      triggerType: next.triggerType,
      scheduledAtIso: next.scheduledAtIso,
      cronExpression: next.cronExpression,
      intervalMs: next.intervalMs,
      timezone: next.timezone,
      dedupeKey: next.dedupeKey,
    },
  );
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
  return okCommitted(
    "delete",
    `Deleted "${displayLabel(loaded.trigger.displayName)}".`,
    triggerReceipt("delete", String(loaded.task.id), { key: null }),
    { taskId: String(loaded.task.id) },
  );
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
  return ok("run", `Ran "${displayLabel(loaded.trigger.displayName)}".`, {
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
  return okCommitted(
    "toggle",
    `${enabled ? "Enabled" : "Disabled"} "${displayLabel(trigger.displayName)}".`,
    triggerReceipt("toggle", String(task.id), { key: null }),
    { taskId: String(task.id), triggerId: trigger.triggerId, enabled },
  );
}

export const triggerAction: Action = {
  name: TRIGGER_ACTION,
  contexts: ["automation", "tasks", "agent_internal"],
  roleGate: { minRole: "ADMIN" },
  similes: ["REMIND_ME", "SET_REMINDER", "REMINDER", "SCHEDULE_REMINDER"],
  routingHint:
    "reminders, alarms, timers, and one-off or recurring scheduled prompts ('remind me in N minutes / at TIME to …', 'every morning …') -> TRIGGER_CREATE; this IS the reminder/scheduler tool whenever it is exposed. For a one-off relative delay pass delaySeconds or delayMinutes only. For a RECURRING request ('every morning/day/week at …') pass cronExpression ALONE — no delaySeconds/delayMinutes/scheduledAtIso, those express a single fire. Do NOT use TASKS_* (those spawn coding sub-agents) and do NOT declare reminders unavailable because OWNER_REMINDERS is absent.",
  description:
    "Recurring/scheduled trigger lifecycle AND user reminders. Action-based dispatch (create / update / delete / run / toggle). Use create for 'remind me in N minutes/at TIME to …' and any scheduled prompt. Supports relative delay (delaySeconds — one-off), a one-off time (scheduledAtIso), interval, and cron (recurring 'every …' schedules).",
  descriptionCompressed:
    "reminders + scheduled prompts: create (remind me in N / at TIME; every X -> cron) update delete run toggle (delay|once|interval|cron)",
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
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = readParams(options);
    const opRaw = readString(
      params.action ?? params.subaction ?? params.op,
    )?.toLowerCase();
    if (!opRaw || !isTriggerOp(opRaw)) {
      return failed(
        "invalid",
        `Invalid action. Expected one of: ${TRIGGER_OPS.join(", ")}.`,
        "TRIGGER_INVALID",
      );
    }
    const op: TriggerOp = opRaw;

    // The handler never emits user-visible text itself: every outcome reaches
    // the planner through the ActionResult. A mid-turn callback here
    // double-posts — the mechanical create line landed seconds before the
    // planner's own confirmation of the same fact. For committed mutations
    // the ActionResult additionally sets `turnComplete`, making the action's
    // humanized ack the turn's single final message instead of being merged
    // with the evaluator's restatement of it.
    switch (op) {
      case "create":
        return opCreate(runtime, message, params);
      case "update":
        return opUpdate(runtime, message, params);
      case "delete":
        return opDelete(runtime, params);
      case "run":
        return opRun(runtime, params);
      case "toggle":
        return opToggle(runtime, params);
    }
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
        "Fire once after this many seconds from now — THE param for 'remind me in N seconds/minutes' (converted to a one-off schedule; use this or delayMinutes for relative delays). One-off only — a recurring 'every …' request takes cronExpression instead, never a delay.",
      required: false,
      aliases: ["inSeconds", "seconds"],
      schema: { type: "number" as const, minimum: 0 },
    },
    {
      name: "delayMinutes",
      description:
        "Fire once after this many minutes from now ('remind me in 5 minutes'). Converted to a one-off schedule. One-off only — a recurring 'every …' request takes cronExpression instead, never a delay.",
      required: false,
      aliases: ["inMinutes", "minutes"],
      schema: { type: "number" as const, minimum: 0 },
    },
    {
      name: "triggerType",
      description:
        "Trigger schedule type for create — usually inferred: cronExpression -> cron (recurring), delay/scheduledAtIso -> once. Set it explicitly only to resolve a conflict; an explicit 'once' or 'interval' outranks a provided cronExpression.",
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
      schema: { type: "number" as const, minimum: 0 },
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
        "Five-field cron expression — THE param for RECURRING schedules ('every morning at 9' -> '0 9 * * *'). Pass it ALONE: do not also send delaySeconds/delayMinutes/scheduledAtIso (those describe a single fire and are ignored when a cron is present). Never for a one-off relative delay; use delaySeconds/delayMinutes for 'in N seconds/minutes'.",
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
          text: 'Reminder set: "review open PRs" — every 12 hours.',
          action: TRIGGER_ACTION,
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: {
          text: "Remind me to take vitamins every morning at 8am.",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'Reminder set: "take vitamins" — every morning at 8am.',
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
          text: 'Disabled "review open PRs".',
          action: TRIGGER_ACTION,
        },
      },
    ],
  ] as ActionExample[][],
};

export { TRIGGER_OPS };
