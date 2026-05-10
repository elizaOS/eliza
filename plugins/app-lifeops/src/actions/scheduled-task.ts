/**
 * `SCHEDULED_TASK` umbrella action.
 *
 * Wave-3 W3-C: collapses the standalone follow-up + reminder verbs into one
 * user-visible umbrella that wraps `ScheduledTaskRunner`. The runner is the
 * single execution surface for `reminder | checkin | followup | approval |
 * recap | watcher | output | custom` ScheduledTasks (frozen contract per
 * `IMPLEMENTATION_PLAN.md` §1).
 *
 * Subactions:
 *   - `list`      — read tasks (optional kind / status / subject filters)
 *   - `get`       — fetch one task by id
 *   - `create`    — schedule a new task (any `ScheduledTaskKind`)
 *   - `update`    — edit a scheduled task (`ScheduledTaskRunner.apply edit`)
 *   - `snooze`    — defer next fire (`apply snooze`); resets the ladder
 *   - `skip`      — `apply skip`; pipeline.onSkip propagates
 *   - `complete`  — `apply complete`; pipeline.onComplete propagates
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
import { createRuntimeScheduledTaskRunner } from "../lifeops/scheduled-task/runtime-wiring.js";

const SUBACTIONS = [
  "list",
  "get",
  "create",
  "update",
  "snooze",
  "skip",
  "complete",
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
  subaction?: Subaction;
  taskId?: string;
  kind?: ScheduledTaskKindParam;
  status?: ScheduledTaskStatusParam | ScheduledTaskStatusParam[];
  subjectKind?: ScheduledTaskSubjectKindParam;
  subjectId?: string;
  ownerVisibleOnly?: boolean;
  /** create-only: free-form prompt instructions for the runner. */
  promptInstructions?: string;
  /** create-only: trigger spec (`once`, `cron`, `manual`, etc). */
  trigger?: ScheduledTaskTrigger;
  priority?: ScheduledTaskPriorityParam;
  respectsGlobalPause?: boolean;
  ownerVisible?: boolean;
  source?: ScheduledTask["source"];
  /** snooze-only: minutes to defer next fire. */
  minutes?: number;
  /** snooze-only: ISO timestamp to defer next fire to. */
  untilIso?: string;
  /** skip / complete / dismiss / reopen: free-form reason. */
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
 * Resolve the umbrella subaction from `params.subaction` (canonical) or any
 * accepted legacy alias (`op`, `action`, `operation`). The canonical key is
 * always tried first; aliases preserve back-compat with cached planner output
 * that predates the project-wide standardization.
 */
function resolveSubaction(params: ScheduledTaskParams): Subaction | null {
  const aliasKeys: readonly (keyof ScheduledTaskParams | string)[] = [
    "subaction",
    "op",
    "action",
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
}

function makeRunnerScope(runtime: IAgentRuntime): RunnerScope {
  const agentId = runtime.agentId;
  const runner = createRuntimeScheduledTaskRunner({ runtime, agentId });
  return { runtime, runner, agentId };
}

function getParams(options: HandlerOptions | undefined): ScheduledTaskParams {
  const raw = (options as HandlerOptions | undefined)?.parameters;
  if (raw && typeof raw === "object") {
    return raw as ScheduledTaskParams;
  }
  return {};
}

function isTrigger(value: unknown): value is ScheduledTaskTrigger {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === "once" ||
    kind === "cron" ||
    kind === "interval" ||
    kind === "relative_to_anchor" ||
    kind === "during_window" ||
    kind === "event" ||
    kind === "manual" ||
    kind === "after_task"
  );
}

async function handleList(
  scope: RunnerScope,
  params: ScheduledTaskParams,
): Promise<ActionResult> {
  const tasks = await scope.runner.list(buildFilter(params));
  return {
    success: true,
    text: `${tasks.length} scheduled task${tasks.length === 1 ? "" : "s"} match.`,
    data: { subaction: "list", tasks },
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
  if (!isTrigger(params.trigger)) {
    return {
      success: false,
      text: "I need a trigger (once / cron / interval / event / manual / …) to schedule a task.",
      data: { subaction: "create", error: "MISSING_TRIGGER" },
    };
  }
  const kind = normalizeKind(params.kind) ?? "custom";
  const priority: ScheduledTaskPriorityParam = params.priority ?? "medium";
  const subject = buildSubject(
    normalizeSubjectKind(params.subjectKind),
    params.subjectId,
  );
  const created = await scope.runner.schedule({
    kind,
    promptInstructions,
    trigger: params.trigger,
    priority,
    respectsGlobalPause: params.respectsGlobalPause ?? true,
    source: params.source ?? "user_chat",
    createdBy: scope.agentId,
    ownerVisible: params.ownerVisible ?? true,
    ...(subject ? { subject } : {}),
  });
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
  return {
    success: true,
    text: `Snoozed scheduled task ${taskId}.`,
    data: { subaction: "snooze", task: snoozed },
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
        action: "SCHEDULED_TASK",
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
        action: "SCHEDULED_TASK",
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
        action: "SCHEDULED_TASK",
      },
    },
  ],
];

export const scheduledTaskAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "SCHEDULED_TASK",
  similes: [
    "SCHEDULED_TASKS",
    "REMINDER_TASK",
    "SCHEDULED_REMINDER",
    "SCHEDULED_FOLLOWUP",
    "TASK_SNOOZE",
    "TASK_COMPLETE",
    "TASK_DISMISS",
    // W3-C drift D-2: collapse the 7 transitional ENTITY follow-up subactions
    // onto SCHEDULED_TASK. ENTITY keeps the same simile names registered for
    // one release; the canonical execution surface is here.
    "ADD_FOLLOW_UP",
    "COMPLETE_FOLLOW_UP",
    "FOLLOW_UP_LIST",
    "DAYS_SINCE",
    "LIST_OVERDUE_FOLLOWUPS",
    "MARK_FOLLOWUP_DONE",
    "SET_FOLLOWUP_THRESHOLD",
  ],
  description:
    "Owner-only. The SCHEDULED_TASK umbrella exposes the ScheduledTask spine: list / get / create / update / snooze / skip / complete / dismiss / cancel / reopen / history. Every reminder, check-in, follow-up, approval, recap, watcher, output, and custom scheduled task lives here. Transitional ENTITY follow-up verbs collapse onto this surface.",
  descriptionCompressed:
    "scheduled-task umbrella: list get create update snooze skip complete dismiss cancel reopen history; kinds=reminder|checkin|followup|approval|recap|watcher|output|custom",
  routingHint:
    'reminder/checkin/followup/approval/recap/watcher/output state ("snooze that", "what follow-ups today", "complete the check-in", "show task history") -> SCHEDULED_TASK; per-occurrence LifeOps verbs (complete/skip/snooze a definition\'s next occurrence) stay on LIFE',
  contexts: ["tasks", "reminders", "followups", "calendar"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  parameters: [
    {
      name: "subaction",
      description:
        "Which scheduled-task operation to run: list | get | create | update | snooze | skip | complete | dismiss | cancel | reopen | history.",
      schema: { type: "string" as const, enum: [...SUBACTIONS] },
    },
    {
      name: "taskId",
      description:
        "Target taskId for get / update / snooze / skip / complete / dismiss / cancel / reopen / history.",
      schema: { type: "string" as const },
    },
    {
      name: "kind",
      description:
        "ScheduledTaskKind for create + filter for list. One of reminder, checkin, followup, approval, recap, watcher, output, custom.",
      schema: { type: "string" as const },
    },
    {
      name: "status",
      description:
        "Status filter for list (string or string[]). One of scheduled, fired, acknowledged, completed, skipped, expired, failed, dismissed.",
      schema: { type: "string" as const } as ActionParameterSchema,
    },
    {
      name: "subjectKind",
      description:
        "ScheduledTaskSubject.kind: entity | relationship | thread | document | calendar_event | self.",
      schema: { type: "string" as const },
    },
    {
      name: "subjectId",
      description: "ScheduledTaskSubject.id paired with subjectKind.",
      schema: { type: "string" as const },
    },
    {
      name: "ownerVisibleOnly",
      description: "When true, list returns only ownerVisible tasks.",
      schema: { type: "boolean" as const },
    },
    {
      name: "promptInstructions",
      description: "create-only: prompt instructions stored on the task.",
      schema: { type: "string" as const },
    },
    {
      name: "trigger",
      description:
        "create-only: ScheduledTaskTrigger object (once / cron / interval / relative_to_anchor / during_window / event / manual / after_task).",
      schema: { type: "object" as const, additionalProperties: true },
    },
    {
      name: "priority",
      description: "create-only: low | medium | high (default medium).",
      schema: { type: "string" as const, enum: ["low", "medium", "high"] },
    },
    {
      name: "respectsGlobalPause",
      description:
        "create-only: when true, the task skips during global pause.",
      schema: { type: "boolean" as const },
    },
    {
      name: "ownerVisible",
      description: "create-only: when true, the task surfaces in owner views.",
      schema: { type: "boolean" as const },
    },
    {
      name: "source",
      description:
        "create-only: task source (default_pack | user_chat | first_run | plugin).",
      schema: { type: "string" as const },
    },
    {
      name: "minutes",
      description: "snooze-only: minutes to defer next fire.",
      schema: { type: "number" as const },
    },
    {
      name: "untilIso",
      description: "snooze-only: ISO-8601 timestamp to defer next fire to.",
      schema: { type: "string" as const },
    },
    {
      name: "reason",
      description:
        "skip / complete / dismiss / reopen: free-form reason recorded on the state log.",
      schema: { type: "string" as const },
    },
    {
      name: "patch",
      description:
        "update-only: shallow patch of editable ScheduledTask fields.",
      schema: { type: "object" as const, additionalProperties: true },
    },
    {
      name: "sinceIso",
      description: "history-only: ISO-8601 lower bound on log occurredAtIso.",
      schema: { type: "string" as const },
    },
    {
      name: "untilHistoryIso",
      description: "history-only: ISO-8601 upper bound on log occurredAtIso.",
      schema: { type: "string" as const },
    },
    {
      name: "includeRollups",
      description:
        "history-only: include rolled-up daily summary log rows (default false; raw rows only).",
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
        text: "Tell me which scheduled-task operation you want: list, get, create, update, snooze, skip, complete, dismiss, cancel, reopen, or history.",
        data: { error: "MISSING_SUBACTION" },
      };
    }

    const scope = makeRunnerScope(runtime);
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
        action: "SCHEDULED_TASK",
      });
    }
    return result;
  },
};
