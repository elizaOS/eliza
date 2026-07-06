/**
 * `SCHEDULED_TASKS` umbrella action.
 *
 * Wraps `ScheduledTaskRunner` — the LifeOps scheduled-item execution surface for
 * `reminder | checkin | followup | approval | recap | watcher | output | custom`
 * `ScheduledTask` records (frozen contract per `IMPLEMENTATION_PLAN.md` §1).
 *
 * Subactions:
 *   - `list`      — read tasks (optional kind / status / subject filters, plus
 *                   a `dueWindow` = overdue|today next-fire filter)
 *   - `get`       — fetch one task by id
 *   - `create`    — schedule a new task (any `ScheduledTaskKind`)
 *   - `update`    — edit a scheduled task (`ScheduledTaskRunner.apply edit`)
 *   - `snooze`    — defer next fire (`apply snooze`); resets the ladder
 *   - `skip`      — `apply skip`; pipeline.onSkip propagates
 *   - `complete`  — `apply complete`; pipeline.onComplete propagates
 *   - `acknowledge` — `apply acknowledge`, then completion-check evaluation
 *   - `dismiss`   — `apply dismiss`; terminal, no propagation
 *   - `cancel`    — alias for `dismiss` (planner-friendly verb)
 *   - `reopen`    — `apply reopen`; reopen-window enforced by the runner
 *   - `history`   — read state-log entries (rollups elided by default)
 *
 * The 7 transitional ENTITY follow-up subactions
 * (`add_follow_up`, `complete_follow_up`, `follow_up_list`, `days_since`,
 * `list_overdue_followups`, `mark_followup_done`, `set_followup_threshold`)
 * collapse onto this surface and live here as similes for one release per
 * `HARDCODING_AUDIT.md` §6 #6.
 */

import type {
  Action,
  ActionExample,
  ActionParameterSchema,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import { resolvePendingPromptsStore } from "../lifeops/pending-prompts/store.js";
import { LifeOpsRepository } from "../lifeops/repository.js";
import type {
  ScheduledTask,
  ScheduledTaskFilter,
  ScheduledTaskKind,
  ScheduledTaskLogEntry,
  ScheduledTaskPriority,
  ScheduledTaskRunnerHandle,
  ScheduledTaskStatus,
  ScheduledTaskSubject,
  ScheduledTaskSubjectKind,
  ScheduledTaskTrigger,
} from "../lifeops/scheduled-task/index.js";
import {
  ChannelKeyError,
  ScheduledTaskValidationError,
} from "../lifeops/scheduled-task/index.js";
import { getScheduledTaskRunner } from "../lifeops/scheduled-task/service.js";
import { OWNER_OPERATION_VALIDATE } from "./life.js";

const SUBACTIONS = [
  "list",
  "get",
  "create",
  "update",
  "snooze",
  "skip",
  "complete",
  "acknowledge",
  "dismiss",
  "cancel",
  "reopen",
  "history",
] as const;

type Subaction = (typeof SUBACTIONS)[number];

type ScheduledTaskKindParam = ScheduledTaskKind;
type ScheduledTaskStatusParam = ScheduledTaskStatus;
type ScheduledTaskSubjectKindParam = ScheduledTaskSubjectKind;
type ScheduledTaskPriorityParam = ScheduledTaskPriority;

interface ScheduledTaskParams {
  action?: Subaction;
  subaction?: Subaction;
  op?: Subaction;
  operation?: Subaction;
  taskId?: string;
  kind?: ScheduledTaskKindParam;
  status?: ScheduledTaskStatusParam | ScheduledTaskStatusParam[];
  subjectKind?: ScheduledTaskSubjectKindParam;
  subjectId?: string;
  ownerVisibleOnly?: boolean;
  /** list-only: restrict to next-fire window `overdue` (past due) or `today`. */
  dueWindow?: "overdue" | "today";
  /** create-only: free-form prompt instructions for the runner. */
  promptInstructions?: string;
  /** create-only: trigger spec (`once`, `cron`, `manual`, etc). */
  trigger?: ScheduledTaskTrigger;
  contextRequest?: ScheduledTask["contextRequest"];
  shouldFire?: ScheduledTask["shouldFire"];
  completionCheck?: ScheduledTask["completionCheck"];
  escalation?: ScheduledTask["escalation"];
  output?: ScheduledTask["output"];
  pipeline?: ScheduledTask["pipeline"];
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  priority?: ScheduledTaskPriorityParam;
  respectsGlobalPause?: boolean;
  ownerVisible?: boolean;
  source?: ScheduledTask["source"];
  /** snooze-only: minutes to defer next fire. */
  minutes?: number;
  /** snooze-only: ISO timestamp to defer next fire to. */
  untilIso?: string;
  /** skip / complete / acknowledge / dismiss / reopen: free-form reason. */
  reason?: string;
  /** update-only: shallow patch of editable fields. */
  patch?: Partial<Omit<ScheduledTask, "taskId" | "state">>;
  /** history-only: ISO lower bound. */
  sinceIso?: string;
  /** history-only: ISO upper bound. */
  untilHistoryIso?: string;
  /** history-only: include rolled-up daily summary entries. */
  includeRollups?: boolean;
  /** history-only: row cap (default 100). */
  limit?: number;
}

const SCHEDULED_TASK_KINDS: readonly ScheduledTaskKindParam[] = [
  "reminder",
  "checkin",
  "followup",
  "approval",
  "recap",
  "watcher",
  "output",
  "custom",
];

const SCHEDULED_TASK_STATUSES: readonly ScheduledTaskStatusParam[] = [
  "scheduled",
  "fired",
  "acknowledged",
  "completed",
  "skipped",
  "expired",
  "failed",
  "dismissed",
];

const SCHEDULED_TASK_SUBJECT_KINDS: readonly ScheduledTaskSubjectKindParam[] = [
  "entity",
  "relationship",
  "thread",
  "document",
  "calendar_event",
  "self",
];

function normalizeSubaction(value: unknown): Subaction | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return (SUBACTIONS as readonly string[]).includes(trimmed)
    ? (trimmed as Subaction)
    : null;
}

/**
 * Resolve the umbrella operation from `params.action` (canonical) or accepted
 * legacy aliases. Aliases preserve back-compat with cached planner output that
 * predates the project-wide standardization.
 */
function resolveSubaction(params: ScheduledTaskParams): Subaction | null {
  const aliasKeys: readonly (keyof ScheduledTaskParams | string)[] = [
    "action",
    "subaction",
    "op",
    "operation",
  ];
  for (const key of aliasKeys) {
    const candidate = (params as Record<string, unknown>)[key];
    const normalized = normalizeSubaction(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function normalizeKind(value: unknown): ScheduledTaskKindParam | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return (SCHEDULED_TASK_KINDS as readonly string[]).includes(trimmed)
    ? (trimmed as ScheduledTaskKindParam)
    : undefined;
}

function normalizeStatus(
  value: unknown,
): ScheduledTaskStatusParam | ScheduledTaskStatusParam[] | undefined {
  if (Array.isArray(value)) {
    const values = value
      .map((entry) =>
        typeof entry === "string" ? entry.trim().toLowerCase() : "",
      )
      .filter((entry): entry is ScheduledTaskStatusParam =>
        (SCHEDULED_TASK_STATUSES as readonly string[]).includes(entry),
      );
    return values.length > 0 ? values : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    return (SCHEDULED_TASK_STATUSES as readonly string[]).includes(trimmed)
      ? (trimmed as ScheduledTaskStatusParam)
      : undefined;
  }
  return undefined;
}

function normalizeSubjectKind(
  value: unknown,
): ScheduledTaskSubjectKindParam | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return (SCHEDULED_TASK_SUBJECT_KINDS as readonly string[]).includes(trimmed)
    ? (trimmed as ScheduledTaskSubjectKindParam)
    : undefined;
}

function buildSubject(
  kind: ScheduledTaskSubjectKindParam | undefined,
  id: string | undefined,
): ScheduledTaskSubject | undefined {
  if (!kind || typeof id !== "string" || id.trim().length === 0) {
    return undefined;
  }
  return { kind, id: id.trim() };
}

function buildFilter(params: ScheduledTaskParams): ScheduledTaskFilter {
  const filter: ScheduledTaskFilter = {};
  const kind = normalizeKind(params.kind);
  if (kind) filter.kind = kind;
  const status = normalizeStatus(params.status);
  if (status !== undefined) filter.status = status;
  const subject = buildSubject(
    normalizeSubjectKind(params.subjectKind),
    params.subjectId,
  );
  if (subject) filter.subject = subject;
  if (params.ownerVisibleOnly === true) filter.ownerVisibleOnly = true;
  return filter;
}

interface RunnerScope {
  runtime: IAgentRuntime;
  runner: ScheduledTaskRunnerHandle;
  agentId: string;
  roomId: string | null;
}

function makeRunnerScope(runtime: IAgentRuntime, message: Memory): RunnerScope {
  const agentId = runtime.agentId;
  const runner = getScheduledTaskRunner(runtime, { agentId });
  return {
    runtime,
    runner,
    agentId,
    roomId: typeof message.roomId === "string" ? message.roomId : null,
  };
}

function getParams(options: HandlerOptions | undefined): ScheduledTaskParams {
  const raw = (options as HandlerOptions | undefined)?.parameters;
  if (raw && typeof raw === "object") {
    return raw as ScheduledTaskParams;
  }
  return {};
}

const TRIGGER_KINDS =
  "once | cron | interval | relative_to_anchor | during_window | event | manual | after_task";

/**
 * Self-repair redirect appended to create-trigger failures. Observed live
 * (gemma-4-31b, `brush-teeth-basic`): a habit-shaped ask routed here, then the
 * model burned every planner continuation retrying `trigger: {}` against the
 * raw scheduler instead of switching to the definition-save flow. The failure
 * text is the only in-turn channel that can steer the retry, so it names the
 * correct surface explicitly.
 */
const HABIT_REDIRECT_HINT =
  "If the owner asked to start a habit/routine or a recurring personal reminder in chat, do not retry here — call OWNER_ROUTINES (or OWNER_REMINDERS) with action=create instead; that flow builds the habit definition and reminder plan without a raw trigger.";

type TriggerNormalization =
  | { ok: true; trigger: ScheduledTaskTrigger }
  | { ok: false; message: string };

function pickString(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function pickNumber(
  record: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * Normalize a planner-supplied trigger into the canonical
 * `ScheduledTaskTrigger` shape, accepting the field aliases LLMs naturally
 * produce (`type` for `kind`; `cron`/`schedule` for `expression`;
 * `timezone` for `tz`; `at`/`when` for `atIso`; `minutes` for
 * `everyMinutes`; …), and validating per-kind completeness so an
 * incomplete trigger can never reach the runner and blow up mid-schedule.
 *
 * Failure messages are written FOR the model: they state the exact
 * canonical shape so a self-repair retry lands on the first attempt.
 * (Observed live: `{type:"cron", schedule:"…"}` and `{kind:"cron",
 * cron:"…"}` each burned a planner retry before the model guessed
 * `expression`, and the mid-runner throw surfaced as a bare
 * `success:false` with no message.)
 */
function normalizeTriggerInput(value: unknown): TriggerNormalization {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      message: `Trigger must be an object with a "kind" field (${TRIGGER_KINDS}).`,
    };
  }
  const record = value as Record<string, unknown>;
  const onceAtIso = pickString(record, [
    "atIso",
    "fireAtIso",
    "fireAt",
    "fire_at",
    "at",
    "when",
    "datetime",
  ]);
  const kindRaw =
    pickString(record, ["kind", "type"]) ?? (onceAtIso ? "once" : null);
  if (!kindRaw) {
    return {
      ok: false,
      message: `Trigger is missing "kind" (${TRIGGER_KINDS}).`,
    };
  }
  const kind = kindRaw.toLowerCase();
  switch (kind) {
    case "cron": {
      const expression = pickString(record, ["expression", "cron", "schedule"]);
      if (!expression) {
        return {
          ok: false,
          message:
            'Cron triggers need { kind: "cron", expression: "<5-field cron>", tz?: "<IANA timezone>" } — e.g. { kind: "cron", expression: "0 8,21 * * *", tz: "America/New_York" }.',
        };
      }
      const tz = pickString(record, ["tz", "timezone", "timeZone"]);
      return {
        ok: true,
        trigger: {
          kind: "cron",
          expression,
          ...(tz ? { tz } : {}),
        } as ScheduledTaskTrigger,
      };
    }
    case "once": {
      const atIso = onceAtIso;
      if (!atIso || !Number.isFinite(Date.parse(atIso))) {
        return {
          ok: false,
          message:
            'Once triggers need { kind: "once", atIso: "<ISO-8601 instant>" } — e.g. { kind: "once", atIso: "2026-07-03T17:00:00-04:00" }.',
        };
      }
      return { ok: true, trigger: { kind: "once", atIso } };
    }
    case "interval": {
      const everyMinutes = pickNumber(record, [
        "everyMinutes",
        "minutes",
        "intervalMinutes",
      ]);
      if (everyMinutes === null || everyMinutes <= 0) {
        return {
          ok: false,
          message:
            'Interval triggers need { kind: "interval", everyMinutes: <positive number>, from?: "<ISO>", until?: "<ISO>" }.',
        };
      }
      const from = pickString(record, ["from"]);
      const until = pickString(record, ["until"]);
      return {
        ok: true,
        trigger: {
          kind: "interval",
          everyMinutes,
          ...(from ? { from } : {}),
          ...(until ? { until } : {}),
        },
      };
    }
    case "relative_to_anchor": {
      const anchorKey = pickString(record, ["anchorKey", "anchor"]);
      const offsetMinutes = pickNumber(record, [
        "offsetMinutes",
        "offset",
        "minutes",
      ]);
      if (!anchorKey || offsetMinutes === null) {
        return {
          ok: false,
          message:
            'relative_to_anchor triggers need { kind: "relative_to_anchor", anchorKey: "<anchor>", offsetMinutes: <number> } — e.g. { kind: "relative_to_anchor", anchorKey: "wake.confirmed", offsetMinutes: 30 }.',
        };
      }
      return {
        ok: true,
        trigger: { kind: "relative_to_anchor", anchorKey, offsetMinutes },
      };
    }
    case "during_window": {
      const windowKey = pickString(record, ["windowKey", "window"]);
      if (!windowKey) {
        return {
          ok: false,
          message:
            'during_window triggers need { kind: "during_window", windowKey: "morning" | "afternoon" | "evening" | "night" | "morning_or_evening" | "morning_or_night" }.',
        };
      }
      return { ok: true, trigger: { kind: "during_window", windowKey } };
    }
    case "event": {
      const eventKind = pickString(record, ["eventKind", "event", "name"]);
      if (!eventKind) {
        return {
          ok: false,
          message:
            'Event triggers need { kind: "event", eventKind: "<event name>" }.',
        };
      }
      const filter = record.filter;
      return {
        ok: true,
        trigger: {
          kind: "event",
          eventKind,
          ...(filter && typeof filter === "object"
            ? { filter: filter as never }
            : {}),
        },
      };
    }
    case "manual":
      return { ok: true, trigger: { kind: "manual" } };
    case "after_task": {
      const taskId = pickString(record, ["taskId", "taskRef", "task"]);
      const outcome = pickString(record, ["outcome"]);
      if (
        !taskId ||
        (outcome !== "completed" &&
          outcome !== "skipped" &&
          outcome !== "failed" &&
          outcome !== "expired" &&
          outcome !== "dismissed")
      ) {
        return {
          ok: false,
          message:
            'after_task triggers need { kind: "after_task", taskId: "<parent task id>", outcome: "completed" | "skipped" | "failed" | "expired" | "dismissed" }.',
        };
      }
      return {
        ok: true,
        trigger: { kind: "after_task", taskId, outcome } as never,
      };
    }
    default:
      return {
        ok: false,
        message: `Unknown trigger kind "${kindRaw}". Valid kinds: ${TRIGGER_KINDS}.`,
      };
  }
}

function stableTriggerKey(trigger: ScheduledTaskTrigger): string {
  const record = trigger as unknown as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .map((key) => `${key}=${JSON.stringify(record[key])}`)
    .join("|");
}

function nonEmptyRecord<T>(value: T | undefined): T | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return Object.keys(value).length > 0 ? value : undefined;
}

function defaultChatOutput(
  scope: RunnerScope,
): ScheduledTask["output"] | undefined {
  return scope.roomId
    ? { destination: "channel", target: `in_app:${scope.roomId}` }
    : undefined;
}

function normalizeOutputDestination(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function normalizeOutputInput(
  scope: RunnerScope,
  output: ScheduledTaskParams["output"],
): ScheduledTask["output"] | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return defaultChatOutput(scope);
  }
  if (Object.keys(output).length === 0) {
    return defaultChatOutput(scope);
  }
  const rawDestination =
    typeof output.destination === "string" ? output.destination.trim() : "";
  const destination = normalizeOutputDestination(rawDestination);
  const rawTarget =
    typeof output.target === "string" && output.target.trim().length > 0
      ? output.target.trim()
      : undefined;
  const inAppTarget =
    rawTarget ?? (scope.roomId ? `in_app:${scope.roomId}` : "in_app");

  if (
    destination === "in_app" ||
    destination === "push" ||
    destination === "notification" ||
    destination.startsWith("in_app:")
  ) {
    return {
      ...output,
      destination: "channel",
      target: destination.startsWith("in_app:") ? rawDestination : inAppTarget,
    };
  }

  if (destination === "channel") {
    return {
      ...output,
      destination: "channel",
      target: rawTarget ?? inAppTarget,
    };
  }

  return output;
}

function normalizeCompletionCheckInput(
  value: ScheduledTaskParams["completionCheck"],
): ScheduledTask["completionCheck"] | undefined {
  const check = nonEmptyRecord(value);
  if (!check) return undefined;
  if (typeof check.kind === "string" && check.kind.trim().length > 0) {
    return check;
  }
  if (typeof (check as { type?: unknown }).type === "string") {
    const kind = (check as { type: string }).type.trim();
    if (kind.length > 0) {
      const { type: _type, ...rest } =
        check as ScheduledTask["completionCheck"] & {
          type?: string;
        };
      return { ...rest, kind };
    }
  }
  return check;
}

const DUE_WINDOWS = ["overdue", "today"] as const;
type DueWindow = (typeof DUE_WINDOWS)[number];

function normalizeDueWindow(value: unknown): DueWindow | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return (DUE_WINDOWS as readonly string[]).includes(trimmed)
    ? (trimmed as DueWindow)
    : undefined;
}

function localDateKey(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const read = (type: string) =>
      parts.find((part) => part.type === type)?.value;
    const year = read("year");
    const month = read("month");
    const day = read("day");
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // error-policy:J3 invalid owner timezone fact falls back to UTC date-key comparison.
    // Invalid owner timezone facts fall back to UTC, matching scheduler helpers.
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Keep tasks whose due instant falls inside `window`, using the runner's
 * due-decision and next-fire projection so the chat/voice filter and scheduler
 * tick share the same owner-facts and anchor dependencies. Already-due tasks
 * are considered before the future next-fire projection; otherwise a missed
 * recurring occurrence can project to tomorrow and disappear from an
 * "overdue" view. Tasks with no wall-clock due time (event/manual/after_task,
 * or settled non-recurring rows) are excluded from both windows. `today` is a
 * superset of `overdue`.
 */
async function filterByDueWindow(
  scope: RunnerScope,
  tasks: ScheduledTask[],
  window: DueWindow,
): Promise<ScheduledTask[]> {
  const now = Date.now();
  const ownerFacts = await scope.runner.resolveOwnerFacts();
  const ownerTimeZone = ownerFacts.timezone ?? "UTC";
  const todayKey = localDateKey(new Date(now), ownerTimeZone);
  const kept: ScheduledTask[] = [];
  for (const task of tasks) {
    const dueDecision = await scope.runner.resolveDueDecision(task);
    if (dueDecision.due) {
      kept.push(task);
      continue;
    }
    if (window === "overdue") continue;
    const nextFireAtIso = await scope.runner.resolveNextFireAt(task);
    if (nextFireAtIso === null) continue;
    const fireMs = Date.parse(nextFireAtIso);
    if (!Number.isFinite(fireMs)) continue;
    if (localDateKey(new Date(fireMs), ownerTimeZone) === todayKey) {
      kept.push(task);
    }
  }
  return kept;
}

async function handleList(
  scope: RunnerScope,
  params: ScheduledTaskParams,
): Promise<ActionResult> {
  const tasks = await scope.runner.list(buildFilter(params));
  const dueWindow = normalizeDueWindow(params.dueWindow);
  const filtered = dueWindow
    ? await filterByDueWindow(scope, tasks, dueWindow)
    : tasks;
  const windowNote = dueWindow ? ` (${dueWindow})` : "";
  return {
    success: true,
    text: `${filtered.length} scheduled task${filtered.length === 1 ? "" : "s"} match${windowNote}.`,
    data: {
      subaction: "list",
      tasks: filtered,
      ...(dueWindow ? { dueWindow } : {}),
    },
  };
}

async function handleGet(
  scope: RunnerScope,
  params: ScheduledTaskParams,
): Promise<ActionResult> {
  const taskId = params.taskId?.trim();
  if (!taskId) {
    return {
      success: false,
      text: "I need a taskId to fetch a scheduled task.",
      data: { subaction: "get", error: "MISSING_TASK_ID" },
    };
  }
  const all = await scope.runner.list();
  const task = all.find((entry) => entry.taskId === taskId) ?? null;
  if (!task) {
    return {
      success: false,
      text: `No scheduled task found with id ${taskId}.`,
      data: { subaction: "get", error: "NOT_FOUND" },
    };
  }
  return {
    success: true,
    text: `Found scheduled task ${task.taskId} (${task.kind}, ${task.state.status}).`,
    data: { subaction: "get", task },
  };
}

async function handleCreate(
  scope: RunnerScope,
  params: ScheduledTaskParams,
): Promise<ActionResult> {
  const promptInstructions =
    typeof params.promptInstructions === "string"
      ? params.promptInstructions.trim()
      : "";
  if (promptInstructions.length === 0) {
    return {
      success: false,
      text: "I need promptInstructions describing what the scheduled task should do.",
      data: { subaction: "create", error: "MISSING_PROMPT_INSTRUCTIONS" },
    };
  }
  if (params.trigger === undefined || params.trigger === null) {
    return {
      success: false,
      text: `I need a trigger (${TRIGGER_KINDS}) to schedule a task. ${HABIT_REDIRECT_HINT}`,
      data: { subaction: "create", error: "MISSING_TRIGGER" },
    };
  }
  const normalized = normalizeTriggerInput(params.trigger);
  if (!normalized.ok) {
    return {
      success: false,
      text: `${normalized.message} ${HABIT_REDIRECT_HINT}`,
      data: {
        subaction: "create",
        error: "INVALID_TRIGGER",
        message: normalized.message,
      },
    };
  }
  const trigger = normalized.trigger;
  const kind = normalizeKind(params.kind) ?? "custom";
  const priority: ScheduledTaskPriorityParam = params.priority ?? "medium";
  const subject = buildSubject(
    normalizeSubjectKind(params.subjectKind),
    params.subjectId,
  );
  // Content-level duplicate guard. `idempotencyKey` already dedupes exact
  // retries, but a planner re-asked across turns tends to mint a NEW key for
  // the same intent (observed live: two identical brush-teeth cron reminders
  // one minute apart under different keys). An ACTIVE task with the same
  // kind + instructions + trigger is the same intent — return it instead of
  // stacking a duplicate reminder. Likewise a create that reuses a
  // planner-invented `taskId` (the runner mints real ids, so it is recorded
  // as `metadata.plannerTaskId` below) is a retry of the same intent, even
  // when the retry rewrites the instructions or trigger (observed live:
  // turn-2 retries reused taskId "brush-teeth-8am-daily" under fresh
  // idempotency keys).
  const requestedTaskId = params.taskId?.trim() || undefined;
  const activeSiblings = await scope.runner.list({
    kind,
    status: ["scheduled", "fired", "acknowledged"],
  });
  const normalizedInstructions = promptInstructions.toLowerCase();
  const triggerKey = stableTriggerKey(trigger);
  const duplicate = activeSiblings.find(
    (candidate) =>
      (candidate.promptInstructions.trim().toLowerCase() ===
        normalizedInstructions &&
        stableTriggerKey(candidate.trigger) === triggerKey) ||
      (requestedTaskId !== undefined &&
        (candidate.taskId === requestedTaskId ||
          candidate.metadata?.plannerTaskId === requestedTaskId)),
  );
  if (duplicate) {
    return {
      success: true,
      text: `An identical ${kind} task already exists (${duplicate.taskId}) — not creating a duplicate.`,
      data: { subaction: "create", task: duplicate, deduplicated: true },
    };
  }
  const output = normalizeOutputInput(scope, params.output);
  const completionCheck = normalizeCompletionCheckInput(params.completionCheck);
  const metadata = {
    ...(params.metadata ?? {}),
    ...(requestedTaskId ? { plannerTaskId: requestedTaskId } : {}),
    ...(scope.roomId && params.completionCheck
      ? { pendingPromptRoomId: scope.roomId }
      : {}),
  };
  let created: ScheduledTask;
  try {
    created = await scope.runner.schedule({
      kind,
      promptInstructions,
      trigger,
      priority,
      ...(nonEmptyRecord(params.contextRequest)
        ? { contextRequest: params.contextRequest }
        : {}),
      ...(nonEmptyRecord(params.shouldFire)
        ? { shouldFire: params.shouldFire }
        : {}),
      ...(completionCheck ? { completionCheck } : {}),
      ...(nonEmptyRecord(params.escalation)
        ? { escalation: params.escalation }
        : {}),
      ...(output ? { output } : {}),
      ...(nonEmptyRecord(params.pipeline) ? { pipeline: params.pipeline } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      ...(params.idempotencyKey
        ? { idempotencyKey: params.idempotencyKey }
        : {}),
      respectsGlobalPause: params.respectsGlobalPause ?? true,
      source: params.source ?? "user_chat",
      createdBy: scope.agentId,
      ownerVisible: params.ownerVisible ?? true,
      ...(subject ? { subject } : {}),
    });
  } catch (error) {
    if (error instanceof ScheduledTaskValidationError) {
      return {
        success: false,
        text: `Scheduled task validation failed: ${error.issues.join("; ")}`,
        data: {
          subaction: "create",
          error: "INVALID_SCHEDULED_TASK",
          issues: error.issues,
        },
      };
    }
    if (error instanceof ChannelKeyError) {
      return {
        success: false,
        text: `Scheduled task validation failed: ${error.message}`,
        data: {
          subaction: "create",
          error: "INVALID_SCHEDULED_TASK",
          issues: [error.message],
        },
      };
    }
    throw error;
  }
  return {
    success: true,
    text: `Scheduled ${kind} task ${created.taskId}.`,
    data: { subaction: "create", task: created },
  };
}

async function handleUpdate(
  scope: RunnerScope,
  params: ScheduledTaskParams,
): Promise<ActionResult> {
  const taskId = params.taskId?.trim();
  if (!taskId) {
    return {
      success: false,
      text: "I need a taskId to update a scheduled task.",
      data: { subaction: "update", error: "MISSING_TASK_ID" },
    };
  }
  if (!params.patch || typeof params.patch !== "object") {
    return {
      success: false,
      text: "I need a `patch` object describing the fields to update.",
      data: { subaction: "update", error: "MISSING_PATCH" },
    };
  }
  const updated = await scope.runner.apply(taskId, "edit", params.patch);
  return {
    success: true,
    text: `Updated scheduled task ${taskId}.`,
    data: { subaction: "update", task: updated },
  };
}

async function handleSnooze(
  scope: RunnerScope,
  params: ScheduledTaskParams,
): Promise<ActionResult> {
  const taskId = params.taskId?.trim();
  if (!taskId) {
    return {
      success: false,
      text: "I need a taskId to snooze a scheduled task.",
      data: { subaction: "snooze", error: "MISSING_TASK_ID" },
    };
  }
  const minutes =
    typeof params.minutes === "number" && Number.isFinite(params.minutes)
      ? params.minutes
      : undefined;
  const untilIso =
    typeof params.untilIso === "string" && params.untilIso.trim().length > 0
      ? params.untilIso.trim()
      : undefined;
  if (minutes === undefined && untilIso === undefined) {
    return {
      success: false,
      text: "I need either `minutes` or `untilIso` to snooze.",
      data: { subaction: "snooze", error: "MISSING_SNOOZE_TARGET" },
    };
  }
  const snoozed = await scope.runner.apply(taskId, "snooze", {
    ...(minutes !== undefined ? { minutes } : {}),
    ...(untilIso ? { untilIso } : {}),
  });
  await resolvePendingPromptsStore(scope.runtime).forgetTask(taskId);
  return {
    success: true,
    text: `Snoozed scheduled task ${taskId}.`,
    data: { subaction: "snooze", task: snoozed },
  };
}

async function handleAcknowledge(
  scope: RunnerScope,
  params: ScheduledTaskParams,
): Promise<ActionResult> {
  const taskId = params.taskId?.trim();
  if (!taskId) {
    return {
      success: false,
      text: "I need a taskId to acknowledge a scheduled task.",
      data: { subaction: "acknowledge", error: "MISSING_TASK_ID" },
    };
  }
  await scope.runner.apply(taskId, "acknowledge");
  const updated = await scope.runner.evaluateCompletion(taskId, {
    acknowledged: true,
  });
  await resolvePendingPromptsStore(scope.runtime).forgetTask(taskId);
  return {
    success: true,
    text: `Acknowledged scheduled task ${taskId}.`,
    data: { subaction: "acknowledge", task: updated },
  };
}

async function handleVerbWithReason(
  scope: RunnerScope,
  params: ScheduledTaskParams,
  verb: "skip" | "complete" | "dismiss" | "reopen",
  label: string,
): Promise<ActionResult> {
  const taskId = params.taskId?.trim();
  if (!taskId) {
    return {
      success: false,
      text: `I need a taskId to ${label} a scheduled task.`,
      data: { subaction: verb, error: "MISSING_TASK_ID" },
    };
  }
  const updated = await scope.runner.apply(
    taskId,
    verb,
    params.reason ? { reason: params.reason } : undefined,
  );
  if (verb === "skip" || verb === "complete" || verb === "dismiss") {
    await resolvePendingPromptsStore(scope.runtime).forgetTask(taskId);
  }
  return {
    success: true,
    text: `${label.charAt(0).toUpperCase()}${label.slice(1)}d scheduled task ${taskId}.`,
    data: { subaction: verb, task: updated },
  };
}

async function handleHistory(
  scope: RunnerScope,
  params: ScheduledTaskParams,
): Promise<ActionResult> {
  const taskId = params.taskId?.trim();
  if (!taskId) {
    return {
      success: false,
      text: "I need a taskId to read history (the state log is partitioned per task).",
      data: { subaction: "history", error: "MISSING_TASK_ID" },
    };
  }
  const repo = new LifeOpsRepository(scope.runtime);
  const limit =
    typeof params.limit === "number" &&
    Number.isFinite(params.limit) &&
    params.limit > 0
      ? Math.floor(params.limit)
      : 100;
  const entries: ScheduledTaskLogEntry[] = await repo.listScheduledTaskLog({
    agentId: scope.agentId,
    taskId,
    ...(params.sinceIso ? { sinceIso: params.sinceIso } : {}),
    ...(params.untilHistoryIso ? { untilIso: params.untilHistoryIso } : {}),
    excludeRollups: params.includeRollups !== true,
    limit,
  });
  return {
    success: true,
    text: `${entries.length} scheduled-task log row${entries.length === 1 ? "" : "s"}.`,
    data: { subaction: "history", entries },
  };
}

const examples: ActionExample[][] = [
  [
    {
      name: "{{name1}}",
      content: { text: "What follow-ups are scheduled for me right now?" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Listing scheduled tasks of kind=followup.",
        action: "SCHEDULED_TASKS",
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "Show me only my overdue tasks." },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Listing scheduled tasks that are past due.",
        action: "SCHEDULED_TASKS",
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "What's due today?" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Listing scheduled tasks due today.",
        action: "SCHEDULED_TASKS",
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "Snooze that reminder 30 minutes." },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Snoozing the active reminder for 30 minutes.",
        action: "SCHEDULED_TASKS",
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "Mark the daily check-in done." },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Marking the check-in as completed.",
        action: "SCHEDULED_TASKS",
      },
    },
  ],
];

export const scheduledTaskAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "SCHEDULED_TASKS",
  similes: [
    "SCHEDULED_TASK",
    "REMINDER_TASK",
    "SCHEDULED_REMINDER",
    "SCHEDULED_FOLLOWUP",
    "TASK_SNOOZE",
    "TASK_COMPLETE",
    "TASK_ACKNOWLEDGE",
    "TASK_DISMISS",
    // ENTITY simile names; canonical execution surface is SCHEDULED_TASKS.
    "ADD_FOLLOW_UP",
    "COMPLETE_FOLLOW_UP",
    "FOLLOW_UP_LIST",
    "DAYS_SINCE",
    "LIST_OVERDUE_FOLLOWUPS",
    "MARK_FOLLOWUP_DONE",
    "SET_FOLLOWUP_THRESHOLD",
    // PRD action-catalog aliases. The PRD's NotificationIntent and
    // event-decision flows fold onto SCHEDULED_TASKS with escalation policy.
    // See packages/docs/action-prd-map.md.
    "EVENT_SET_DECISION_DEADLINE",
    "EVENT_TRACK_ASSET_DEADLINES",
    "NOTIFICATION_CREATE_INTENT",
    "NOTIFICATION_ACKNOWLEDGE",
    "NOTIFICATION_ESCALATE",
  ],
  tags: [
    "domain:lifeops",
    "domain:reminders",
    "resource:scheduled-item",
    "resource:scheduled-task",
    "capability:read",
    "capability:write",
    "capability:update",
    "capability:delete",
    "capability:schedule",
    "surface:internal",
  ],
  description:
    "Low-level admin surface over LifeOps ScheduledTask records. Kinds: reminder, checkin, followup, approval, recap, watcher, output, custom. Ops: list|get|create|update|snooze|skip|complete|acknowledge|dismiss|cancel|reopen|history. create schedules a raw task and requires an explicit structural trigger — it is NOT the flow for saving a habit/routine/recurring personal reminder the owner asks for in chat; OWNER_ROUTINES / OWNER_REMINDERS action=create own that (definition + reminder plan).",
  descriptionCompressed:
    "low-level scheduled-item admin list|get|create|update|snooze|skip|complete|ack|dismiss|cancel|history; NOT new-habit/routine creation (-> OWNER_ROUTINES/OWNER_REMINDERS create)",
  routingHint:
    'manage EXISTING scheduled items ("snooze that reminder", "show me only overdue tasks" -> action=list dueWindow=overdue, "what\'s due today" -> action=list dueWindow=today, "complete check-in", "scheduled-item history") -> SCHEDULED_TASKS; NEW habit/routine/recurring personal reminder ("brush my teeth at 8 am and 9 pm every day", "remind me daily at 9pm") -> OWNER_ROUTINES/OWNER_REMINDERS action=create; coding/project/agent task threads -> TASKS/plugin-task-coordinator; per-occurrence complete/skip/snooze next occurrence -> OWNER_REMINDERS/OWNER_TODOS/OWNER_ROUTINES',
  contexts: [
    "tasks",
    "automation",
    "reminders",
    "followups",
    "calendar",
    "productivity",
  ],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: OWNER_OPERATION_VALIDATE,
  parameters: [
    {
      name: "action",
      description:
        "ScheduledTask op: list|get|create|update|snooze|skip|complete|acknowledge|dismiss|cancel|reopen|history.",
      schema: { type: "string" as const, enum: [...SUBACTIONS] },
    },
    {
      name: "taskId",
      description:
        "Target taskId for get/update/snooze/skip/complete/acknowledge/dismiss/cancel/reopen/history.",
      schema: { type: "string" as const },
    },
    {
      name: "kind",
      description:
        "ScheduledTaskKind create/filter: reminder|checkin|followup|approval|recap|watcher|output|custom.",
      schema: { type: "string" as const },
    },
    {
      name: "status",
      description:
        "List status filter string|string[]: scheduled|fired|acknowledged|completed|skipped|expired|failed|dismissed.",
      schema: { type: "string" as const } as ActionParameterSchema,
    },
    {
      name: "subjectKind",
      description:
        "ScheduledTaskSubject.kind: entity|relationship|thread|document|calendar_event|self.",
      schema: { type: "string" as const },
    },
    {
      name: "subjectId",
      description: "ScheduledTaskSubject.id paired with subjectKind.",
      schema: { type: "string" as const },
    },
    {
      name: "ownerVisibleOnly",
      description: "true: list ownerVisible tasks only.",
      schema: { type: "boolean" as const },
    },
    {
      name: "dueWindow",
      description:
        'list-only next-fire filter: "overdue" (fire time already past) or "today" (fires before end of the local day). Use for "show me only overdue tasks" / "what\'s due today".',
      schema: { type: "string" as const, enum: [...DUE_WINDOWS] },
    },
    {
      name: "promptInstructions",
      description: "create-only: promptInstructions stored on ScheduledTask.",
      schema: { type: "string" as const },
    },
    {
      name: "trigger",
      description:
        "create-only: ScheduledTaskTrigger once/cron/interval/relative_to_anchor/during_window/event/manual/after_task.",
      schema: { type: "object" as const, additionalProperties: true },
    },
    {
      name: "contextRequest",
      description:
        "create-only: contextRequest facts/entities/relationships/recent task states/event payload.",
      schema: { type: "object" as const, additionalProperties: true },
    },
    {
      name: "shouldFire",
      description:
        "create-only: structural shouldFire gates; gate refs, no prompt text conditions.",
      schema: { type: "object" as const, additionalProperties: true },
    },
    {
      name: "completionCheck",
      description:
        "create-only: structural completionCheck: user_replied_within|user_acknowledged|subject_updated|health_signal_observed.",
      schema: { type: "object" as const, additionalProperties: true },
    },
    {
      name: "output",
      description:
        "create-only: output destination/target, e.g. channel -> in_app:<roomId>.",
      schema: { type: "object" as const, additionalProperties: true },
    },
    {
      name: "pipeline",
      description:
        "create-only: pipeline child ScheduledTask refs: onComplete|onSkip|onFail.",
      schema: { type: "object" as const, additionalProperties: true },
    },
    {
      name: "escalation",
      description: "create-only: escalation ladder/channel steps.",
      schema: { type: "object" as const, additionalProperties: true },
    },
    {
      name: "metadata",
      description: "create-only: structured task metadata.",
      schema: { type: "object" as const, additionalProperties: true },
    },
    {
      name: "idempotencyKey",
      description: "create-only: stable dedupe key for repeated schedules.",
      schema: { type: "string" as const },
    },
    {
      name: "priority",
      description: "create-only: low|medium|high; default medium.",
      schema: { type: "string" as const, enum: ["low", "medium", "high"] },
    },
    {
      name: "respectsGlobalPause",
      description: "create-only: true skips during global pause.",
      schema: { type: "boolean" as const },
    },
    {
      name: "ownerVisible",
      description: "create-only: true shows in owner views.",
      schema: { type: "boolean" as const },
    },
    {
      name: "source",
      description:
        "create-only: source default_pack|user_chat|first_run|plugin.",
      schema: { type: "string" as const },
    },
    {
      name: "minutes",
      description: "snooze-only: defer next fire N minutes.",
      schema: { type: "number" as const },
    },
    {
      name: "untilIso",
      description: "snooze-only: defer next fire until ISO-8601 timestamp.",
      schema: { type: "string" as const },
    },
    {
      name: "reason",
      description:
        "skip/complete/acknowledge/dismiss/reopen: reason on state log.",
      schema: { type: "string" as const },
    },
    {
      name: "patch",
      description: "update-only: shallow patch editable ScheduledTask fields.",
      schema: { type: "object" as const, additionalProperties: true },
    },
    {
      name: "sinceIso",
      description: "history-only: occurredAtIso >= ISO-8601.",
      schema: { type: "string" as const },
    },
    {
      name: "untilHistoryIso",
      description: "history-only: occurredAtIso <= ISO-8601.",
      schema: { type: "string" as const },
    },
    {
      name: "includeRollups",
      description:
        "history-only: include daily rollups; default false/raw only.",
      schema: { type: "boolean" as const },
    },
    {
      name: "limit",
      description: "history-only: row cap (default 100).",
      schema: { type: "number" as const },
    },
  ],
  examples,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text = "Scheduled-task control is restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }

    const params = getParams(options);
    const subaction = resolveSubaction(params);
    if (!subaction) {
      return {
        success: false,
        text: "Tell me which task operation you want: list, get, create, update, snooze, skip, complete, acknowledge, dismiss, cancel, reopen, or history.",
        data: { error: "MISSING_SUBACTION" },
      };
    }

    const scope = makeRunnerScope(runtime, message);
    let result: ActionResult;
    switch (subaction) {
      case "list":
        result = await handleList(scope, params);
        break;
      case "get":
        result = await handleGet(scope, params);
        break;
      case "create":
        result = await handleCreate(scope, params);
        break;
      case "update":
        result = await handleUpdate(scope, params);
        break;
      case "snooze":
        result = await handleSnooze(scope, params);
        break;
      case "skip":
        result = await handleVerbWithReason(scope, params, "skip", "skip");
        break;
      case "complete":
        result = await handleVerbWithReason(
          scope,
          params,
          "complete",
          "complete",
        );
        break;
      case "acknowledge":
        result = await handleAcknowledge(scope, params);
        break;
      case "dismiss":
      case "cancel":
        // `cancel` is a planner-friendly alias for the runner's `dismiss`
        // verb — both terminate the task without firing pipeline hooks.
        result = await handleVerbWithReason(
          scope,
          params,
          "dismiss",
          "dismiss",
        );
        break;
      case "reopen":
        result = await handleVerbWithReason(scope, params, "reopen", "reopen");
        break;
      case "history":
        result = await handleHistory(scope, params);
        break;
    }

    if (result.text) {
      await callback?.({
        text: result.text,
        source: "action",
        action: "SCHEDULED_TASKS",
      });
    }
    return result;
  },
};
