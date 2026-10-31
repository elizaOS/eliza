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
  type EffectReceipt,
  extractUserText,
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
  textStatesExplicitRecurrence,
  toWellFormedUnicode,
  type UUID,
  unwrapUserMessageText,
  validateUuid,
} from "@elizaos/core";

import {
  AUTONOMY_SERVICE_TYPE,
  resolveMessageTimeZone,
} from "@elizaos/plugin-assistant";
import {
  describeCronSchedule,
  describeIntervalMs,
  describeOnceAt,
  zonedIsoTimestamp,
} from "../triggers/humanize.ts";
import {
  executeTriggerTask,
  readTriggerConfig,
  TRIGGER_TASK_NAME,
  TRIGGER_TASK_TAGS,
  triggersFeatureEnabled,
} from "../triggers/runtime.ts";
import {
  buildTriggerMetadata,
  computeNextCronRunAtMs,
  DISABLED_TRIGGER_INTERVAL_MS,
  normalizeTriggerIntervalMs,
  parseCronExpression,
  parseScheduledAtIso,
  resolveScheduledAtIsoInTimeZone,
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

const TRIGGER_OPS = [
  "create",
  "update",
  "delete",
  "run",
  "toggle",
  "list",
] as const;
type TriggerOp = (typeof TRIGGER_OPS)[number];
const TRIGGER_SCHEDULE_OPS: readonly TriggerOp[] = ["create", "update"];
const TRIGGER_NAMED_OPS: readonly TriggerOp[] = [
  "create",
  "update",
  "delete",
  "run",
  "toggle",
];

const TRIGGER_ACTION = "TRIGGER";
const MAX_TRIGGERS_PER_CREATOR = 100;
/** A planner retry of a relative-delay reminder lands within this window. */
const RELATIVE_DELAY_REPLAY_WINDOW_MS = 60_000;
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
  // A sentence safe to show the user verbatim. `text` is model-facing and
  // routinely carries operator hints ("Pass taskId or a displayName
  // fragment") that must never reach chat; without this the turn falls back to
  // the generic "the available runtime step failed" string and the user learns
  // nothing (live 2026-08-14: "cancel the reminder about the oven").
  userFacingText?: string,
): ActionResult {
  const code = `TRIGGER_${op.toUpperCase()}_FAILED`;
  return {
    success: false,
    text,
    ...(userFacingText ? { userFacingText } : {}),
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

// Committed receipts ground the model's confirmation without prescribing its
// wording. Replayed no-ops retain the same durable-state proof as fresh writes.
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

// Keep mutation evidence available to the planner; conversational wording is
// generated after the action, rather than delivering this diagnostic text.
function okCommitted(
  op: TriggerOp,
  text: string,
  receipt: EffectReceipt,
  data?: Record<string, unknown>,
  values?: Record<string, unknown>,
): ActionResult {
  return {
    ...ok(op, text, data, values),
    modelReplyRequired: true,
    effectReceipts: [receipt],
  };
}

function missingSchedule(text: string): ActionResult {
  return {
    ...failed("create", text, "MISSING_SCHEDULE", {
      acceptance: "rejected",
      executionStatus: "not_started",
    }),
    // No write has started: corrected schedule parameters can safely retry.
    // Keep this validation rejection in the trace without giving it authority
    // over a later committed creation with those corrected parameters.
    failureProvenance: {
      kind: "handler_error",
      boundary: "handler",
      code: "MISSING_SCHEDULE",
      retryable: true,
    },
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

// Delay-derived once triggers hash the RELATIVE delay, not the absolute fire
// time: a planner retry/double-emit of the same tool call lands milliseconds
// apart and must dedupe to one reminder. This single helper feeds both the
// create-path key and the persisted key, so an update can never silently swap
// schemes and re-open the duplicate window. Triggers that were never
// delay-derived fall back to the absolute timestamp.
function onceScheduleDedupeKey(trigger: {
  delayMs?: number;
  scheduledAtIso?: string;
}): string {
  return trigger.delayMs !== undefined
    ? `+${trigger.delayMs}`
    : (trigger.scheduledAtIso ?? "");
}

function persistedScheduleDedupeKey(trigger: TriggerConfig): string {
  if (trigger.triggerType === "once") {
    return onceScheduleDedupeKey(trigger);
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
  persistedNextRunAtMs?: number,
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
  // A cron trigger capped at one run IS a one-shot: it fires at the next
  // occurrence and never again. Describing it by its cron shape ("every
  // morning at 9am") reports a recurrence the trigger cannot have — the live
  // shape: "remind me tomorrow at 9am" confirmed back as "every morning".
  if (t.maxRuns === 1 && t.cronExpression) {
    const nextMs =
      persistedNextRunAtMs ??
      computeNextCronRunAtMs(
        t.cronExpression,
        nowMs,
        t.timezone ?? messageTimeZone,
      );
    const friendly =
      nextMs !== null
        ? describeOnceAt(new Date(nextMs).toISOString(), nowMs, messageTimeZone)
        : null;
    if (friendly) return friendly;
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

async function loadTriggerTask(
  runtime: IAgentRuntime,
  taskId: UUID,
): Promise<{ task: Task; trigger: TriggerConfig } | null> {
  const task = await runtime.getTask(taskId);
  if (!task?.id) return null;
  const trigger = readTriggerConfig(task);
  return trigger ? { task, trigger } : null;
}

async function loadTriggerByTriggerId(
  runtime: IAgentRuntime,
  triggerId: string,
): Promise<{ task: Task; trigger: TriggerConfig } | null> {
  const tasks = await runtime.getTasks({
    tags: [...TRIGGER_TASK_TAGS],
    agentIds: [runtime.agentId],
  });
  for (const task of tasks) {
    const trigger = readTriggerConfig(task);
    if (trigger && task.id && String(trigger.triggerId) === triggerId) {
      return { task, trigger };
    }
  }
  return null;
}

/**
 * Resolve which trigger a delete/run/toggle refers to. Accepts a task
 * UUID, the triggerId, or — the way a person actually refers to one — a name
 * fragment matched against displayName/instructions. Users never see task
 * UUIDs, so demanding one made every "delete the X reminder" turn fail.
 * Exactly one match resolves; none or several return a structured failure
 * that lists the active triggers so the model can correct in one step.
 */
const TRIGGER_REQUEST_LEAD_PATTERN =
  /^(?:(?:hey|hi|ok|okay|please)[\s,]+)*(?:please\s+)?(?:can you\s+|could you\s+|would you\s+)?(?:delete|cancel|remove|stop|clear|drop|kill|turn off|disable|pause|resume|enable|run|fire)\s+(?:the\s+|my\s+|that\s+|this\s+)?/i;
const TRIGGER_NOUN_PATTERN =
  /\b(?:triggers?|reminders?|alerts?|alarms?|tasks?|notifications?|please|now)\b/gi;
const MENTION_MARKER_PATTERN = /<@!?\d{6,}>|[^()\n]{0,80}\(@\d{6,}\)/gu;

/**
 * The trigger the user named in a request the planner sent without any
 * target ("delete the landlord trigger" arrived as `{action: "delete"}`,
 * live 2026-09-14, and the not-found text became the delivered reply
 * although the retry deleted it). The words after the leading verb, minus
 * the generic nouns; undefined when nothing usable remains.
 */
export function impliedTriggerQuery(
  message: Memory | undefined,
): string | undefined {
  if (!message) return undefined;
  const text = unwrapUserMessageText(message)
    .replace(MENTION_MARKER_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
  const firstClause = text.split(/[.!?;\n]/)[0] ?? "";
  if (!TRIGGER_REQUEST_LEAD_PATTERN.test(firstClause)) return undefined;
  const query = firstClause
    .replace(TRIGGER_REQUEST_LEAD_PATTERN, "")
    .replace(TRIGGER_NOUN_PATTERN, " ")
    .replace(/\b(?:about|for|to|that|the|my|a|an)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /[a-z]{3,}/i.test(query) ? query : undefined;
}

function normalizeTriggerName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^trigger:\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const WORD_CHAR = "[\\p{L}\\p{M}\\p{N}]";
// These scripts attach particles without a space ("운동을"), so a name inside
// a query stays a substring match there.
const PARTICLE_SCRIPT_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function containsWholePhrase(text: string, phrase: string): boolean {
  if (!phrase) return false;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!${WORD_CHAR})${escaped}(?!${WORD_CHAR})`, "u").test(
    text,
  );
}

/**
 * 0 = exact name, 1 = whole word/phrase either way, 2 = substring (a name
 * inside the query only for particle scripts), undefined = no match.
 */
function triggerNameMatchTier(
  name: string,
  query: string,
): 0 | 1 | 2 | undefined {
  if (!name || !query) return undefined;
  if (name === query) return 0;
  if (containsWholePhrase(name, query) || containsWholePhrase(query, name)) {
    return 1;
  }
  if (
    name.includes(query) ||
    (PARTICLE_SCRIPT_PATTERN.test(name) && query.includes(name))
  ) {
    return 2;
  }
  return undefined;
}

async function resolveTriggerRef(
  runtime: IAgentRuntime,
  op: TriggerOp,
  params: TriggerParameters,
  message?: Memory,
): Promise<{ task: Task; trigger: TriggerConfig } | ActionResult> {
  const taskId = readUuid(params.taskId);
  if (taskId) {
    const loaded = await loadTriggerTask(runtime, taskId);
    if (loaded) {
      // For ops where displayName is a REFERENCE (not a payload — update
      // renames through it), a planner-supplied id must agree with the
      // planner-supplied name. Context id/name mis-pairing is real: a live
      // turn deleted the "pushups every morning" trigger while naming
      // "water the orchid" because the id short-circuited unchecked.
      const referenceName =
        op === "delete" || op === "run" || op === "toggle"
          ? readString(params.displayName)
          : undefined;
      if (referenceName) {
        const actual = normalizeTriggerName(loaded.trigger.displayName);
        const stated = normalizeTriggerName(referenceName);
        if (
          stated &&
          actual &&
          triggerNameMatchTier(actual, stated) === undefined
        ) {
          return failed(
            op,
            `taskId resolves to "${displayLabel(loaded.trigger.displayName)}", not "${referenceName}". Not ${op === "delete" ? "deleting" : op === "run" ? "running" : "toggling"} — re-check the id or refer to the trigger by name only.`,
            "TRIGGER_REF_MISMATCH",
            { taskId: String(loaded.task.id) },
          );
        }
      }
      return loaded;
    }
  }
  const rawId = readString(params.taskId);
  // A non-uuid taskId is the planner naming the trigger ("Email landlord
  // (nubs)", live 2026-09-13): resolve it as a display-name fragment instead of
  // failing and costing a replan with the id copied from the failure text.
  const querySource =
    readString(params.displayName) ??
    readString(params.instructions) ??
    (rawId && !readUuid(params.taskId) ? rawId : undefined) ??
    impliedTriggerQuery(message);
  const query = querySource ? normalizeTriggerName(querySource) : undefined;

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

  // The first tier with any hit wins, so "Standup" is not ambiguous with
  // "Standup notes" and "Gym" is not hit by "gymnastics".
  const tiers: Array<Array<{ task: Task; trigger: TriggerConfig }>> = [
    [],
    [],
    [],
  ];
  if (query) {
    for (const c of all) {
      const name = normalizeTriggerName(c.trigger.displayName);
      const instructions = normalizeTriggerName(c.trigger.instructions);
      let tier = triggerNameMatchTier(name, query);
      if (tier === undefined || tier > 1) {
        if (containsWholePhrase(instructions, query)) tier = 1;
        else if (tier === undefined && instructions.includes(query)) tier = 2;
      }
      if (tier !== undefined) tiers[tier].push(c);
    }
  }
  const matches = tiers.find((tier) => tier.length > 0) ?? [];
  if (matches.length === 1) return matches[0];

  const names = all.map((c) => `"${c.trigger.displayName}"`).join(", ");
  if (matches.length > 1) {
    const shown = matches.map((c) => `"${c.trigger.displayName}"`).join(", ");
    return failed(
      op,
      `Several triggers match: ${shown}. Name one exactly.`,
      "TRIGGER_AMBIGUOUS",
      undefined,
      `More than one reminder matches that: ${shown}. Which one?`,
    );
  }
  // Nothing was changed by a miss, so the failure never outranks a later
  // successful call's reply (readOnlyOperation), and a call with no target
  // at all is a malformed call, not a lookup miss.
  if (!query && !rawId) {
    return failed(
      op,
      all.length
        ? `taskId or displayName is required. Active triggers: ${names}.`
        : "taskId or displayName is required. No triggers exist.",
      "TRIGGER_MISSING_TARGET",
      { readOnlyOperation: true },
      all.length
        ? `Which reminder do you mean? The ones set are: ${names}.`
        : "You don't have any reminders set right now.",
    );
  }
  return failed(
    op,
    all.length
      ? `No trigger matched. Active triggers: ${names}. Pass taskId or a displayName fragment.`
      : "No triggers exist.",
    "TRIGGER_NOT_FOUND",
    { readOnlyOperation: true },
    all.length
      ? `I couldn't find a reminder matching that — it may have already gone off. The ones still set are: ${names}.`
      : "You don't have any reminders set right now.",
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
  if (!triggersFeatureEnabled(runtime)) {
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
  // The user's words, not chat augmentation's help-document envelope: this
  // text becomes the prompt a reminder fires with when instructions are
  // omitted. The external-content envelope stays on untrusted text.
  const text = extractUserText(readString(message.content.text) ?? "");
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
  // A triggerType alone names a kind, not a time. The rejection names the
  // field for each phrasing: "Provide an explicit schedule" named none, and
  // the planner resent the same unscheduled call four times (live
  // tj-7471737298abb6). interval keeps its own intervalMs rejection below.
  if (
    explicitType !== "interval" &&
    params.delaySeconds === undefined &&
    params.delayMinutes === undefined &&
    params.intervalMs === undefined &&
    !readString(params.scheduledAtIso) &&
    !readString(params.cronExpression)
  ) {
    return missingSchedule(
      "No schedule was sent, so nothing was created. Send delayMinutes or delaySeconds as a number for a relative delay, scheduledAtIso for a clock time, or cronExpression for a repeat.",
    );
  }

  const cronExpression = readString(params.cronExpression);
  // The planner works from CURRENT_TIME in the user's zone, so a timestamp it
  // sends without an offset is that zone's wall clock — the same zone the cron
  // path stores — not the host process zone `Date.parse` would assume.
  const messageTimeZone = resolveMessageTimeZone(runtime, message);
  const rawScheduledAtIso = readString(params.scheduledAtIso);
  const explicitScheduledAtIso =
    rawScheduledAtIso === undefined
      ? undefined
      : resolveScheduledAtIsoInTimeZone(rawScheduledAtIso, messageTimeZone);
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
  const parsedIntervalMs = parsePositiveInt(params.intervalMs);
  // An explicit triggerType=interval with a usable intervalMs is a typed
  // statement like a cron: the delay beside it is the planner's echo of the
  // first fire, not a second schedule.
  const wantsInterval =
    explicitType === "interval" && parsedIntervalMs !== undefined;
  const parsedDelayMs =
    wantsCron || wantsInterval || explicitScheduledAtIso !== undefined
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
  // A relative delay that survived to here is one-shot by definition. Cron and
  // an explicit interval with a usable intervalMs resolved above and discarded
  // it, so a delay can no longer demote a recurring schedule to one-shot.
  const triggerType: TriggerType = wantsCron
    ? "cron"
    : delayMs !== undefined
      ? "once"
      : deriveTriggerType({ ...params, scheduledAtIso });
  const displayName =
    readString(params.displayName) ??
    `Trigger: ${toWellFormedUnicode(instructions)}`;
  const wakeMode: TriggerWakeMode =
    params.wakeMode?.trim().toLowerCase() === "next_autonomy_cycle"
      ? "next_autonomy_cycle"
      : "inject_now";
  const creatorId = String(message.entityId);
  // A repeat period sent with a one-off time and no triggerType names two
  // schedules. Writing the one-off dropped the period and turned "every 2
  // hours" into one committed reminder.
  if (
    triggerType === "once" &&
    explicitType !== "once" &&
    parsedIntervalMs !== undefined
  ) {
    return missingSchedule(
      "intervalMs (repeating) was sent with a one-off delay or scheduledAtIso. Nothing was created. Send intervalMs alone for a repeating trigger, or the delay or scheduledAtIso alone for a one-off.",
    );
  }
  // triggerType=interval names the schedule kind, not the cadence. Writing the
  // 12-hour default here turned "every 2 hours" with the number omitted into a
  // committed 12-hour reminder; once and cron already refuse a missing value.
  if (triggerType === "interval" && params.intervalMs === undefined) {
    return missingSchedule(
      "Interval trigger requires intervalMs (the repeat period in milliseconds).",
    );
  }
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
  let maxRuns = parsePositiveInt(params.maxRuns);
  // A field-spraying planner answering "pushups every morning at 8am" emits
  // the cron AND maxRuns:1 from its derived one-shot echo, silently turning a
  // routine into a single fire. When the user's own words state a repeating
  // cadence (explicit-recurrence markers only — time-of-day window phrases
  // like "in the morning" appear in one-shot asks and must NOT drop the cap),
  // the recurrence wins and the sprayed one-shot cap is dropped.
  if (maxRuns === 1 && cronExpression && textStatesExplicitRecurrence(text)) {
    maxRuns = undefined;
  }

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
      ? onceScheduleDedupeKey({
          delayMs: usedDelay ? delayMs : undefined,
          scheduledAtIso,
        })
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

  // Match the complete request and creator before replaying a committed receipt.
  // A relative-delay key names the delay, not the fire time, so it is a replay
  // only while the stored fire time is within the retry window: the same "in
  // 1 hour" asked 40 minutes later is a new reminder.
  const exactDuplicate = existingTasks.find((t) => {
    const cfg = readTriggerConfig(t);
    return Boolean(
      cfg?.enabled &&
        cfg.createdBy === creatorId &&
        cfg.dedupeKey === dedupeKey &&
        (!usedDelay ||
          Math.abs(
            Date.parse(cfg.scheduledAtIso ?? "") -
              Date.parse(scheduledFromDelay ?? ""),
          ) <= RELATIVE_DELAY_REPLAY_WINDOW_MS),
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
    // Delay-derived once triggers keep the relative delay so the persisted
    // dedupe key uses the same relative scheme as the create-path key.
    delayMs: usedDelay ? delayMs : undefined,
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
  const schedule = describeSchedule(
    triggerConfig,
    messageTimeZone,
    Date.now(),
    metadata.trigger?.nextRunAtMs,
  );
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
      // Read by the reply model, so in the sender's zone; the stored config
      // and the trigger API keep their own form.
      scheduledAtIso:
        triggerConfig.scheduledAtIso &&
        zonedIsoTimestamp(triggerConfig.scheduledAtIso, messageTimeZone),
      cronExpression: triggerConfig.cronExpression,
      intervalMs: triggerConfig.intervalMs,
      timezone: triggerConfig.timezone,
    },
    { triggerId, taskId, workflowId },
  );
}

/**
 * A disabled trigger has no next fire by definition — `resolveTriggerTiming`
 * returns null for `enabled === false`, so `buildTriggerMetadata` can never
 * schedule one. Park it on the far-future disabled interval instead, the same
 * shape event triggers already use, so the row persists as paused and a later
 * resume recomputes a real schedule.
 */
function pausedTriggerMetadata(
  task: Task,
  trigger: TriggerConfig,
  nowMs: number,
): TriggerTaskMetadata {
  return {
    ...((task.metadata as TriggerTaskMetadata | undefined) ?? {}),
    blocking: true,
    updatedAt: nowMs,
    updateInterval: DISABLED_TRIGGER_INTERVAL_MS,
    trigger: { ...trigger, nextRunAtMs: nowMs + DISABLED_TRIGGER_INTERVAL_MS },
  };
}

async function opUpdate(
  runtime: IAgentRuntime,
  message: Memory,
  params: TriggerParameters,
): Promise<ActionResult> {
  // Both lookups run before any write, so a miss changed nothing: marked
  // read-only, it never outranks a later applied mutation's reply (live
  // 2026-09-14, tj-239c3d599bc9e6: update with a malformed taskId, then a
  // delete and a create that applied, and the turn was forced through a
  // "do not claim success" compose pass).
  const taskId = readUuid(params.taskId);
  if (!taskId) {
    const rawId = readString(params.taskId);
    return failed(
      "update",
      rawId
        ? `update needs the trigger task UUID or triggerId in taskId; got "${rawId}".`
        : "taskId is required.",
      "MISSING_TASK_ID",
      { readOnlyOperation: true },
    );
  }
  // create returns both ids and the schema accepts either one here.
  const loaded =
    (await loadTriggerTask(runtime, taskId)) ??
    (await loadTriggerByTriggerId(runtime, taskId));
  if (!loaded)
    return failed(
      "update",
      `Trigger task not found: ${taskId}`,
      "TRIGGER_NOT_FOUND",
      { readOnlyOperation: true },
    );
  const { task, trigger } = loaded;
  if (!task.id)
    return failed("update", "Task missing id.", "TASK_NOT_FOUND", {
      readOnlyOperation: true,
    });
  const messageTimeZone = resolveMessageTimeZone(runtime, message);

  // update patches the stored schedule in place. A field it cannot apply used
  // to be dropped, and the unchanged trigger came back with an applied receipt.
  const unusable: string[] = [];
  const requestedType = readString(params.triggerType)?.toLowerCase();
  if (requestedType !== undefined && requestedType !== trigger.triggerType) {
    unusable.push(
      `triggerType cannot change (stored: ${trigger.triggerType}); delete the trigger and create a new one`,
    );
  }
  if (
    params.enabled !== undefined &&
    readBool(params.enabled, trigger.enabled) !== trigger.enabled
  ) {
    unusable.push("enabled is changed with action=toggle");
  }
  const scheduleFields = [
    ["intervalMs", "interval"],
    ["delaySeconds", "once"],
    ["delayMinutes", "once"],
    ["scheduledAtIso", "once"],
    ["cronExpression", "cron"],
  ] as const;
  for (const [field, type] of scheduleFields) {
    const supplied =
      field === "scheduledAtIso" || field === "cronExpression"
        ? readString(params[field]) !== undefined
        : params[field] !== undefined;
    if (supplied && trigger.triggerType !== type) {
      unusable.push(
        `${field} applies to a ${type} trigger; this trigger is ${trigger.triggerType}`,
      );
    }
  }
  if (
    params.intervalMs !== undefined &&
    parsePositiveInt(params.intervalMs) === undefined
  ) {
    unusable.push("intervalMs must be a positive integer");
  }
  // A relative delay moves a once trigger to that long from now, read as on
  // create: delaySeconds wins over delayMinutes and an explicit scheduledAtIso
  // wins over both. Refused here, "actually make it 30 minutes" cost a planner
  // round (live tj-9f09a0f51d65aa: INVALID_UPDATE on delayMinutes, then the
  // same move again as scheduledAtIso).
  const rawScheduledAtIso = readString(params.scheduledAtIso);
  const delayMs =
    rawScheduledAtIso === undefined ? readRelativeDelayMs(params) : undefined;
  if (
    trigger.triggerType === "once" &&
    rawScheduledAtIso === undefined &&
    (params.delaySeconds !== undefined || params.delayMinutes !== undefined)
  ) {
    if (delayMs === undefined) {
      unusable.push(
        "delaySeconds/delayMinutes must be a positive whole number",
      );
    } else if (delayMs > MAX_RELATIVE_DELAY_MS) {
      unusable.push(
        "relative delay too large; use scheduledAtIso for far-future triggers",
      );
    }
  }
  if (unusable.length > 0) {
    return failed(
      "update",
      `Nothing was changed. ${unusable.join(". ")}.`,
      "INVALID_UPDATE",
      { readOnlyOperation: true, taskId: String(task.id) },
    );
  }

  const next: TriggerConfig = { ...trigger };
  const displayName = readString(params.displayName);
  const instructions = readString(params.instructions);
  const intervalMs = parsePositiveInt(params.intervalMs);
  // Same rule as create: no offset means the user's wall clock.
  const scheduledAtIso =
    rawScheduledAtIso !== undefined
      ? resolveScheduledAtIsoInTimeZone(rawScheduledAtIso, messageTimeZone)
      : delayMs !== undefined
        ? new Date(Date.now() + delayMs).toISOString()
        : undefined;
  const cronExpression = readString(params.cronExpression);
  const maxRuns = parsePositiveInt(params.maxRuns);
  const wakeModeRaw = params.wakeMode?.trim().toLowerCase();
  let dedupeIdentityChanged = false;

  if (
    displayName === undefined &&
    instructions === undefined &&
    intervalMs === undefined &&
    scheduledAtIso === undefined &&
    cronExpression === undefined &&
    maxRuns === undefined &&
    wakeModeRaw !== "inject_now" &&
    wakeModeRaw !== "next_autonomy_cycle"
  ) {
    return failed(
      "update",
      "Nothing was changed. Pass displayName, instructions, wakeMode, maxRuns, or the schedule field for this trigger type.",
      "NO_UPDATE_FIELDS",
      { readOnlyOperation: true, taskId: String(task.id) },
    );
  }

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
    const atMs = parseScheduledAtIso(scheduledAtIso);
    // Same rule as create: a past once-time becomes updateInterval 0, and the
    // scheduler then treats the repeat task as invalid and never fires it.
    if (atMs === null || atMs <= Date.now()) {
      return failed(
        "update",
        "Once trigger requires a valid future scheduledAtIso.",
        "INVALID_SCHEDULE",
      );
    }
    dedupeIdentityChanged =
      dedupeIdentityChanged || scheduledAtIso !== trigger.scheduledAtIso;
    // A relative move keeps create's relative dedupe identity. An explicit
    // move replaces the original relative schedule identity; replaying the
    // existing time must keep the original retry identity.
    if (delayMs !== undefined) next.delayMs = delayMs;
    else if (scheduledAtIso !== trigger.scheduledAtIso) delete next.delayMs;
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

  // An edit keeps a paused trigger paused, like the PUT route; resume
  // recomputes the edited schedule.
  const metadata = next.enabled
    ? buildTriggerMetadata({
        trigger: next,
        nowMs: Date.now(),
        existingMetadata: task.metadata as TriggerTaskMetadata | undefined,
      })
    : pausedTriggerMetadata(task, next, Date.now());
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
      Date.now(),
      // A paused row holds the far-future parked time, not a real fire time.
      next.enabled ? metadata.trigger?.nextRunAtMs : undefined,
    )}${next.enabled ? "" : " (paused)"}.`,
    triggerReceipt("update", String(task.id), { key: null }),
    {
      taskId: String(task.id),
      triggerId: next.triggerId,
      triggerType: next.triggerType,
      scheduledAtIso:
        next.scheduledAtIso &&
        zonedIsoTimestamp(next.scheduledAtIso, messageTimeZone),
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
  message?: Memory,
): Promise<ActionResult> {
  const loaded = await resolveTriggerRef(runtime, "delete", params, message);
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
  message?: Memory,
): Promise<ActionResult> {
  const loaded = await resolveTriggerRef(runtime, "run", params, message);
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

async function opList(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<ActionResult> {
  const tasks = await runtime.getTasks({
    tags: [...TRIGGER_TASK_TAGS],
    agentIds: [runtime.agentId],
  });
  const messageTimeZone = resolveMessageTimeZone(runtime, message);
  const lines: string[] = [];
  // update takes only an id, and no other read returns one. The ids travel in
  // the result data (model-facing), not in the user-facing lines.
  const entries: { taskId: string; triggerId: string; displayName: string }[] =
    [];
  // Rows tagged as triggers whose metadata will not parse are dropped here.
  // Silently dropping them turned "what reminders do I have" into a flat "none
  // are set" for a user whose reminder rows failed the parse, so the count of
  // unreadable rows travels with both branches instead of vanishing.
  let unreadable = 0;
  for (const task of tasks) {
    const trigger = readTriggerConfig(task);
    if (!trigger || !task.id) {
      unreadable += 1;
      continue;
    }
    // A toggled-off trigger still exists as a task but will not fire. Listing
    // it unmarked answers "when does my next reminder fire" with something
    // that never will, so the paused state travels with the line.
    const paused = trigger.enabled === false ? " (paused)" : "";
    entries.push({
      taskId: String(task.id),
      triggerId: trigger.triggerId,
      displayName: trigger.displayName,
    });
    lines.push(
      `- "${displayLabel(trigger.displayName)}" — ${describeSchedule(
        trigger,
        messageTimeZone,
        Date.now(),
        trigger.nextRunAtMs,
      )}${paused}`,
    );
  }
  if (lines.length === 0) {
    return ok(
      "list",
      unreadable === 0
        ? "No reminders or scheduled triggers are set."
        : `No readable reminders or scheduled triggers. ${unreadable} tagged trigger task${unreadable === 1 ? "" : "s"} exist but their trigger config could not be read, so this is not proof that nothing is scheduled.`,
      { count: 0, unreadable },
    );
  }
  const skippedNote =
    unreadable === 0
      ? ""
      : ` (${unreadable} more tagged trigger task${unreadable === 1 ? "" : "s"} could not be read and are not listed)`;
  return ok(
    "list",
    `${lines.length} scheduled item${lines.length === 1 ? "" : "s"}${skippedNote}:\n${lines.join("\n")}`,
    { count: lines.length, unreadable, entries },
  );
}

async function opToggle(
  runtime: IAgentRuntime,
  params: TriggerParameters,
  message?: Memory,
): Promise<ActionResult> {
  const loaded = await resolveTriggerRef(runtime, "toggle", params, message);
  if ("success" in loaded) return loaded;
  const { task, trigger } = loaded;
  if (!task.id) return failed("toggle", "Task missing id.", "TASK_NOT_FOUND");
  const enabled =
    params.enabled === undefined ? !trigger.enabled : readBool(params.enabled);
  const next: TriggerConfig = { ...trigger, enabled };
  const nowMs = Date.now();
  if (enabled && next.triggerType === "once") {
    const atMs = next.scheduledAtIso
      ? parseScheduledAtIso(next.scheduledAtIso)
      : null;
    // Resuming after the fire time used to persist updateInterval 0 and
    // report success. The scheduler skips that repeat task forever.
    if (atMs === null || atMs <= nowMs) {
      return failed(
        "toggle",
        "Once trigger requires a valid future scheduledAtIso.",
        "INVALID_SCHEDULE",
      );
    }
  }
  // Recomputing timing for the about-to-be-paused config always failed, so
  // pausing was structurally impossible ("Failed to recompute trigger
  // schedule." on every pause; live capture). See pausedTriggerMetadata.
  const metadata = enabled
    ? buildTriggerMetadata({
        trigger: next,
        nowMs,
        existingMetadata: task.metadata as TriggerTaskMetadata | undefined,
      })
    : pausedTriggerMetadata(task, next, nowMs);
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
  // "toggle" is the op name, not the user's word. Without pause/resume
  // vocabulary the planner found no lexical bridge and told the user the
  // reminder tool was unavailable while `list` worked in the same session
  // (live capture: "pause the stretch reminder").
  similes: [
    "REMIND_ME",
    "SET_REMINDER",
    "REMINDER",
    "SCHEDULE_REMINDER",
    "PAUSE_REMINDER",
    "RESUME_REMINDER",
    "SNOOZE_REMINDER",
    "DISABLE_REMINDER",
    "ENABLE_REMINDER",
    "STOP_REMINDER",
  ],
  // Routing only; what each operation needs lives once in the description.
  // Both render beside every exposed TRIGGER tool, and the schedule rules
  // used to be stated in both, plus again in four parameter descriptions.
  routingHint:
    "reminders, alarms, timers, and one-off or recurring scheduled prompts ('remind me in N minutes / at TIME to …', 'every morning …') -> TRIGGER_CREATE; 'pause the X reminder', 'stop reminding me about X', 'turn X back on' -> toggle, which keeps the trigger (not delete). This is the core fallback when OWNER_REMINDERS is unavailable; when OWNER_REMINDERS is exposed, explicit owner-reminder creation belongs to it, and a reminder it created (its id is in an OWNER_REMINDERS receipt, never a TRIGGER taskId) is updated, toggled or deleted through OWNER_REMINDERS, not TRIGGER. Do NOT use TASKS_* (those spawn coding sub-agents) and do NOT declare reminders unavailable because OWNER_REMINDERS is absent.",
  description:
    "User reminders and scheduled prompts: create, update, delete, run, toggle, list. Every create needs one schedule field or nothing is created: delayMinutes or delaySeconds for 'in N minutes', scheduledAtIso for a clock time, cronExpression for a repeat ('every …'), intervalMs for a fixed period. A repeat takes cronExpression alone, never a delay. Use update to change an existing reminder's time, name or text in place ('actually make it 30 minutes', 'move it to 5pm'), not by deleting it and creating it again; only a switch between one-off and recurring needs a new trigger. update, delete, run and toggle act only on triggers this action created or listed; a reminder saved through OWNER_REMINDERS is changed with OWNER_REMINDERS. toggle pauses (enabled:false) or resumes (enabled:true) a reminder and keeps it. Use list for 'what reminders do I have' / 'when does my next reminder fire'; reminders are not calendar events and never appear in the calendar feed.",
  descriptionCompressed:
    "reminders + scheduled prompts: create (remind me in N / at TIME; every X -> cron) update (change a trigger's time/name in place: 'make it 30 minutes'; an OWNER_REMINDERS reminder updates there) delete run toggle (pause/resume a reminder) list ('what reminders do i have' / 'when's my next reminder' -> list)",
  suppressPostActionContinuation: true,

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions,
  ): Promise<boolean> => {
    const params = readParams(options);
    const op = readString(params.action ?? params.subaction ?? params.op);
    // Collection-time capability check runs with NO params (the planner has
    // not emitted a call yet) — requiring `op` here silently dropped TRIGGER
    // from every planner surface (observed live: a group-channel "remind me
    // in 3 minutes" had no reminder tool because TRIGGER validate-rejected
    // at collection). Available when uncalled; op validity is enforced when
    // a concrete call arrives.
    if (op === undefined && Object.keys(params).length === 0) return true;
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

    // Results and receipts feed the normal planner's model-generated reply.
    switch (op) {
      case "create":
        return opCreate(runtime, message, params);
      case "update":
        return opUpdate(runtime, message, params);
      case "delete":
        return opDelete(runtime, params, message);
      case "run":
        return opRun(runtime, params, message);
      case "toggle":
        return opToggle(runtime, params, message);
      case "list":
        return opList(runtime, message);
    }
  },

  // Each promoted TRIGGER_<OP> carries only the fields its operation reads.
  // Schedule descriptions stay shorter than the planner's cross-tool
  // "Use the identical full description ... on tool TRIGGER" pointer, so
  // TRIGGER_CREATE keeps them when TRIGGER is exposed beside it.
  // The schedule fields come last: every live TRIGGER_CREATE call wrote its
  // fields in schema order, and none that opened with displayName or
  // instructions sent the delay listed before them (live tj-7471737298abb6
  // and tj-6eff78bef6be90 errored that way with full descriptions shown).
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
        "Trigger task UUID (or triggerId) for update / delete / run / toggle. delete/run/toggle also resolve by displayName fragment when omitted; update needs the id, which action=list returns for each trigger in its result data (entries[].taskId). An OWNER_REMINDERS reminder id is not a taskId.",
      required: false,
      // opUpdate rejects a call without it (MISSING_TASK_ID). Optional on
      // TRIGGER_UPDATE, the planner sent it bare three times before a fourth
      // round supplied the id (live 2026-10-30, tj-6e8277ba0331ca).
      requiredForSubactions: ["update"],
      subactions: ["update", "delete", "run", "toggle"],
      aliases: ["triggerId", "id"],
      schema: { type: "string" as const },
    },
    {
      name: "triggerType",
      description:
        "Trigger schedule type for create — usually inferred: cronExpression -> cron (recurring), delay/scheduledAtIso -> once. Set it explicitly only to resolve a conflict; an explicit 'once' or 'interval' outranks a provided cronExpression.",
      required: false,
      subactions: TRIGGER_SCHEDULE_OPS,
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
      subactions: TRIGGER_NAMED_OPS,
      aliases: ["name", "title", "query"],
      schema: { type: "string" as const },
    },
    {
      name: "instructions",
      description: "Trigger instructions (create / update).",
      required: false,
      // delete/run/toggle fall back to it as a name fragment.
      subactions: TRIGGER_NAMED_OPS,
      aliases: ["description", "message", "prompt", "body"],
      schema: { type: "string" as const },
    },
    {
      name: "wakeMode",
      description: "How the trigger wakes the agent.",
      required: false,
      subactions: TRIGGER_SCHEDULE_OPS,
      schema: {
        type: "string" as const,
        enum: ["inject_now", "next_autonomy_cycle"],
      },
    },
    {
      name: "maxRuns",
      description: "Optional max runs for a trigger.",
      required: false,
      subactions: TRIGGER_SCHEDULE_OPS,
      schema: { type: "number" as const, minimum: 1 },
    },
    {
      name: "delaySeconds",
      description:
        "Schedule: fire once this many seconds from now ('in 90 seconds').",
      required: false,
      subactions: TRIGGER_SCHEDULE_OPS,
      aliases: ["inSeconds", "seconds"],
      schema: { type: "number" as const, minimum: 0 },
    },
    {
      name: "delayMinutes",
      description:
        "Schedule: fire once this many minutes from now ('in 20 minutes').",
      required: false,
      subactions: TRIGGER_SCHEDULE_OPS,
      aliases: ["inMinutes", "minutes"],
      schema: { type: "number" as const, minimum: 0 },
    },
    {
      name: "intervalMs",
      description: "Schedule: repeat period in milliseconds.",
      required: false,
      subactions: TRIGGER_SCHEDULE_OPS,
      schema: { type: "number" as const, minimum: 0 },
    },
    {
      name: "scheduledAtIso",
      description:
        "Schedule: one-off ISO time; with no Z or offset it is the user's local time.",
      required: false,
      subactions: TRIGGER_SCHEDULE_OPS,
      aliases: ["scheduledFor", "when", "at", "datetime"],
      schema: { type: "string" as const },
    },
    {
      name: "cronExpression",
      description:
        "Schedule: five-field cron for a repeat ('every day at 9' is '0 9 * * *').",
      required: false,
      subactions: TRIGGER_SCHEDULE_OPS,
      aliases: ["schedule", "cron", "recurrence"],
      schema: { type: "string" as const },
    },
    {
      name: "enabled",
      description: "Enable or disable a trigger (toggle).",
      required: false,
      subactions: ["toggle"],
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
