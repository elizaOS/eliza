import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";

import { bookTravelAction } from "./book-travel.js";
import { healthAction } from "./health.js";
import { lifeAction } from "./life.js";
import { moneyAction } from "./money.js";
import { scheduleAction } from "./schedule.js";
import { schedulingNegotiationAction } from "./scheduling-negotiation.js";
import { screenTimeAction } from "./screen-time.js";
import { createApprovalQueue } from "../lifeops/approval-queue.js";

const OWNER_LIFE_ACTIONS = [
  "create",
  "update",
  "delete",
  "complete",
  "skip",
  "snooze",
  "review",
] as const;

type OwnerLifeAction = (typeof OWNER_LIFE_ACTIONS)[number];
const OWNER_GOAL_ACTIONS = ["create", "update", "delete", "review"] as const;
const OWNER_HEALTH_ACTIONS = ["today", "trend", "by_metric", "status"] as const;
const OWNER_SCREENTIME_ACTIONS = [
  "summary",
  "today",
  "weekly",
  "weekly_average_by_app",
  "by_app",
  "by_website",
  "activity_report",
  "time_on_app",
  "time_on_site",
  "browser_activity",
] as const;
const OWNER_FINANCE_ACTIONS = [
  "dashboard",
  "list_sources",
  "add_source",
  "remove_source",
  "import_csv",
  "list_transactions",
  "spending_summary",
  "recurring_charges",
  "subscription_audit",
  "subscription_cancel",
  "subscription_status",
] as const;
function readParam(options: unknown, key: string): unknown {
  if (!options || typeof options !== "object") return undefined;
  const record = options as Record<string, unknown>;
  const params = record.parameters as Record<string, unknown> | undefined;
  return params?.[key] ?? record[key];
}

function readStringParam(options: unknown, key: string): string | undefined {
  const value = readParam(options, key);
  return typeof value === "string" ? value : undefined;
}

function readParameters(options: unknown): Record<string, unknown> {
  if (!options || typeof options !== "object") return {};
  const record = options as Record<string, unknown>;
  const params = record.parameters;
  return params && typeof params === "object" && !Array.isArray(params)
    ? { ...(params as Record<string, unknown>) }
    : { ...record };
}

function withParameters(
  options: unknown,
  parameters: Record<string, unknown>,
): { parameters: Record<string, unknown> } & Record<string, unknown> {
  if (!options || typeof options !== "object") {
    return { parameters };
  }
  const record = options as Record<string, unknown>;
  return {
    ...record,
    parameters,
  };
}

function mirrorActionToSubaction(options: unknown): unknown {
  const params = readParameters(options);
  const action =
    typeof params.action === "string"
      ? params.action
      : typeof params.subaction === "string"
        ? params.subaction
        : undefined;
  return withParameters(options, {
    ...params,
    ...(action ? { action, subaction: action } : {}),
  });
}

function normalizeOwnerActionFromAllowed<TAction extends string>(
  options: unknown,
  allowed: readonly TAction[],
): TAction | undefined {
  const raw =
    readStringParam(options, "action") ??
    readStringParam(options, "subaction") ??
    readStringParam(options, "op") ??
    readStringParam(options, "operation");
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase().replace(/[-\s]+/g, "_");
  return allowed.includes(normalized as TAction)
    ? (normalized as TAction)
    : undefined;
}

function delegateHandler(
  target: Action,
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: unknown,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  return target.handler(
    runtime,
    message,
    state,
    options as Parameters<NonNullable<Action["handler"]>>[3],
    callback,
  );
}

function makeOwnerLifeAction(args: {
  name: string;
  similes: string[];
  description: string;
  descriptionCompressed: string;
  defaultKind: "definition" | "goal";
  actions?: readonly OwnerLifeAction[];
}): Action {
  const allowedActions = args.actions ?? OWNER_LIFE_ACTIONS;
  return {
    name: args.name,
    similes: args.similes,
    description: args.description,
    descriptionCompressed: args.descriptionCompressed,
    routingHint: `${args.descriptionCompressed} -> ${args.name}; owner-only LifeOps surface`,
    tags: lifeAction.tags,
    contexts: lifeAction.contexts,
    roleGate: lifeAction.roleGate,
    suppressPostActionContinuation: lifeAction.suppressPostActionContinuation,
    validate: lifeAction.validate,
    parameters: [
	    {
	      name: "action",
	      description:
	          `Owner item operation: ${allowedActions.join(", ")}.`,
	      required: false,
	      schema: { type: "string" as const, enum: [...allowedActions] },
	    },
      {
        name: "kind",
        description:
          "Optional override. Defaults to the owner surface's backing kind.",
        required: false,
        schema: { type: "string" as const, enum: ["definition", "goal"] },
      },
      {
        name: "intent",
        description: "Free-form owner request used for extraction and replies.",
        required: false,
        schema: { type: "string" as const },
      },
      {
        name: "title",
        description: "Item title when known.",
        required: false,
        schema: { type: "string" as const },
      },
      {
        name: "target",
        description: "Existing item id or title for update/delete/complete/skip/snooze/review.",
        required: false,
        schema: { type: "string" as const },
      },
      {
        name: "minutes",
        description: "Minutes to snooze, when action=snooze.",
        required: false,
        schema: { type: "number" as const },
      },
      {
        name: "details",
        description: "Structured schedule, cadence, notes, or other extracted details.",
        required: false,
        schema: { type: "object" as const, additionalProperties: true },
      },
    ],
	    handler: async (runtime, message, state, options, callback) => {
	      const params = readParameters(options);
	      const action = normalizeOwnerActionFromAllowed(options, allowedActions);
      const merged = {
        ...params,
        ...(params.kind ? {} : { kind: args.defaultKind }),
        ...(action ? { action, subaction: action } : {}),
        ownerSurface: args.name,
      };
      return delegateHandler(
        lifeAction,
        runtime,
        message,
        state,
        withParameters(options, merged),
        callback,
      );
    },
  };
}

export const ownerRemindersAction = makeOwnerLifeAction({
  name: "OWNER_REMINDERS",
  similes: ["REMINDER", "REMINDERS", "SET_REMINDER", "REMIND_ME", "REMIND_ME_TO"],
  description:
    "Owner reminders: create, update, delete, complete, skip, snooze, or review one-off and recurring reminders.",
  descriptionCompressed:
    "owner reminders: action=create|update|delete|complete|skip|snooze|review",
  defaultKind: "definition",
});

export const ownerAlarmsAction = makeOwnerLifeAction({
  name: "OWNER_ALARMS",
  similes: ["ALARM", "ALARMS", "WAKE_ME", "WAKE_UP"],
  description:
    "Owner alarms: create, update, delete, complete, skip, snooze, or review alarm-like reminders.",
  descriptionCompressed:
    "owner alarms: action=create|update|delete|complete|skip|snooze|review",
  defaultKind: "definition",
});

export const ownerGoalsAction = makeOwnerLifeAction({
  name: "OWNER_GOALS",
  similes: ["GOAL", "GOALS", "LONG_TERM_GOAL"],
  description:
    "Owner goals: create, update, delete, or review long-term goals and progress.",
  descriptionCompressed:
    "owner goals: action=create|update|delete|review; backing kind=goal",
  defaultKind: "goal",
  actions: [...OWNER_GOAL_ACTIONS],
});

// Owner-store todos surface. Backed by the app-lifeops owner definitions store
// (with kind=definition occurrence tracking). The general-purpose planner
// surface — backed by @elizaos/core TodosService — is TODO in
// plugins/plugin-todos/src/actions/todo.ts. The two surfaces target different
// stores and must not be merged.
export const ownerTodosAction = makeOwnerLifeAction({
  name: "OWNER_TODOS",
  similes: ["TODO", "TODOS", "TASK", "PERSONAL_TASK"],
  description:
    "Owner todos: create, update, delete, complete, skip, snooze, or review personal todos.",
  descriptionCompressed:
    "owner todos: action=create|update|delete|complete|skip|snooze|review",
  defaultKind: "definition",
});

const OWNER_ROUTINE_ACTIONS = [
  ...OWNER_LIFE_ACTIONS,
  "schedule_summary",
  "schedule_inspect",
] as const;

type OwnerRoutineAction = (typeof OWNER_ROUTINE_ACTIONS)[number];

function normalizeOwnerRoutineAction(options: unknown): OwnerRoutineAction | undefined {
  const raw =
    readStringParam(options, "action") ??
    readStringParam(options, "subaction") ??
    readStringParam(options, "op") ??
    readStringParam(options, "operation");
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase().replace(/[-\s]+/g, "_");
  return (OWNER_ROUTINE_ACTIONS as readonly string[]).includes(normalized)
    ? (normalized as OwnerRoutineAction)
    : undefined;
}

export const ownerRoutinesAction: Action = {
  ...makeOwnerLifeAction({
    name: "OWNER_ROUTINES",
    similes: ["HABIT", "HABITS", "ROUTINE", "ROUTINES", "DAILY_TASK", "WEEKLY_TASK"],
    description:
      "Owner routines and habits: create or manage recurring routines, and inspect passive schedule inference.",
    descriptionCompressed:
      "owner routines: action=create|update|delete|complete|skip|snooze|review|schedule_summary|schedule_inspect",
    defaultKind: "definition",
  }),
  parameters: [
    {
      name: "action",
      description:
        "Routine operation: create, update, delete, complete, skip, snooze, review, schedule_summary, or schedule_inspect.",
      required: false,
      schema: { type: "string" as const, enum: [...OWNER_ROUTINE_ACTIONS] },
    },
    ...(makeOwnerLifeAction({
      name: "OWNER_ROUTINES",
      similes: [],
      description: "",
      descriptionCompressed: "",
      defaultKind: "definition",
    }).parameters ?? []).filter((parameter) => parameter.name !== "action"),
  ],
  handler: async (runtime, message, state, options, callback) => {
    const action = normalizeOwnerRoutineAction(options);
    if (action === "schedule_summary" || action === "schedule_inspect") {
      const params = {
        ...readParameters(options),
        subaction: action === "schedule_inspect" ? "inspect" : "summary",
      };
      return delegateHandler(
        scheduleAction,
        runtime,
        message,
        state,
        withParameters(options, params),
        callback,
      );
    }
    const params = readParameters(options);
    const merged = {
      ...params,
      ...(params.kind ? {} : { kind: "definition" }),
      ...(action ? { action, subaction: action } : {}),
      ownerSurface: "OWNER_ROUTINES",
    };
    return delegateHandler(
      lifeAction,
      runtime,
      message,
      state,
      withParameters(options, merged),
      callback,
    );
  },
};

export const ownerHealthAction: Action = {
  ...healthAction,
  name: "OWNER_HEALTH",
  similes: ["HEALTH", "FITNESS", "WELLNESS", ...(healthAction.similes ?? [])],
  description:
    "Owner health telemetry reads across HealthKit, Google Fit, Strava, Fitbit, Withings, or Oura. Actions: today, trend, by_metric, status.",
  descriptionCompressed:
    "owner health: today|trend|by_metric|status; read-only telemetry",
  routingHint:
    'owner health/wearable reads ("step count", "sleep last night", heart rate, workouts) -> OWNER_HEALTH',
  parameters: [
    {
      name: "action",
      description: "Owner health read action: today, trend, by_metric, or status.",
      required: false,
      schema: { type: "string" as const, enum: [...OWNER_HEALTH_ACTIONS] },
    },
    ...(healthAction.parameters ?? []).filter(
      (parameter) => parameter.name !== "subaction",
    ),
  ],
  handler: (runtime, message, state, options, callback) =>
    delegateHandler(
      healthAction,
      runtime,
      message,
      state,
      mirrorActionToSubaction(options),
      callback,
    ),
};

export const ownerScreenTimeAction: Action = {
  ...screenTimeAction,
  name: "OWNER_SCREENTIME",
  similes: ["SCREENTIME", "SCREEN_TIME", "ACTIVITY_REPORT", ...(screenTimeAction.similes ?? [])],
  description:
    "Owner screen-time and activity analytics across local activity, app usage, and browser reports.",
  descriptionCompressed:
    "owner screentime: summary|today|weekly|by_app|by_website|activity_report|time_on_app|time_on_site|browser_activity",
  parameters: [
    {
      name: "action",
      description: "Owner screentime read action.",
      required: false,
      schema: { type: "string" as const, enum: [...OWNER_SCREENTIME_ACTIONS] },
    },
    ...(screenTimeAction.parameters ?? []).filter(
      (parameter) => parameter.name !== "subaction",
    ),
  ],
  handler: (runtime, message, state, options, callback) =>
    delegateHandler(
      screenTimeAction,
      runtime,
      message,
      state,
      mirrorActionToSubaction(options),
      callback,
    ),
};

export const ownerFinancesAction: Action = {
  ...moneyAction,
  name: "OWNER_FINANCES",
  similes: ["MONEY", "FINANCES", "SUBSCRIPTIONS", ...(moneyAction.similes ?? [])],
  description:
    "Owner finances: payment sources, transaction imports, spending summaries, recurring charges, and subscription audits.",
  descriptionCompressed:
    "owner finances: dashboard|list_sources|add_source|remove_source|import_csv|list_transactions|spending_summary|recurring_charges|subscription_audit|subscription_cancel|subscription_status",
  parameters: [
    {
      name: "action",
      description: "Owner finance action.",
      required: false,
      schema: { type: "string" as const, enum: [...OWNER_FINANCE_ACTIONS] },
    },
    ...(moneyAction.parameters ?? []).filter(
      (parameter) => parameter.name !== "subaction",
    ),
  ],
  handler: (runtime, message, state, options, callback) =>
    delegateHandler(
      moneyAction,
      runtime,
      message,
      state,
      mirrorActionToSubaction(options),
      callback,
    ),
};

const PERSONAL_ASSISTANT_ACTIONS = [
  "book_travel",
  "scheduling",
  "sign_document",
] as const;

function getMessageText(message: Memory): string {
  const text = message.content?.text;
  return typeof text === "string" ? text : "";
}

function firstUrl(text: string): string | null {
  return text.match(/https?:\/\/\S+/u)?.[0] ?? null;
}

function defaultSignatureDeadline(text: string): string {
  const inDays = /\bin\s+(\d+)\s+days?\b/iu.exec(text);
  if (inDays?.[1]) {
    const date = new Date(Date.now() + Number(inDays[1]) * 24 * 60 * 60 * 1000);
    return date.toISOString();
  }
  return new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
}

async function enqueueDocumentSignatureApproval(args: {
  runtime: IAgentRuntime;
  message: Memory;
  options: unknown;
  callback?: HandlerCallback;
}): Promise<ActionResult> {
  const params = readParameters(args.options);
  const text = getMessageText(args.message);
  const documentName =
    readStringParam(args.options, "documentName") ??
    readStringParam(args.options, "document_name") ??
    (/nda/i.test(text) ? "NDA" : "Document for signature");
  const documentId =
    readStringParam(args.options, "documentId") ??
    readStringParam(args.options, "document_id") ??
    `signature-${String(args.message.id ?? Date.now())}`;
  const signatureUrl =
    readStringParam(args.options, "signatureUrl") ??
    readStringParam(args.options, "signature_url") ??
    firstUrl(text) ??
    "pending-signature-url";
  const deadline =
    readStringParam(args.options, "deadline") ?? defaultSignatureDeadline(text);
  const subjectUserId =
    typeof args.message.entityId === "string"
      ? args.message.entityId
      : String(args.runtime.agentId);

  const queue = createApprovalQueue(args.runtime, {
    agentId: args.runtime.agentId,
  });
  const request = await queue.enqueue({
    requestedBy: "PERSONAL_ASSISTANT",
    subjectUserId,
    action: "sign_document",
    payload: {
      action: "sign_document",
      documentId,
      documentName,
      signatureUrl,
      deadline,
    },
    channel: "internal",
    reason:
      typeof params.reason === "string" && params.reason.trim().length > 0
        ? params.reason.trim()
        : `Initiate signing flow for ${documentName}`,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  const responseText = `Queued the ${documentName} signing flow for approval before anything is sent.`;
  await args.callback?.({
    text: responseText,
    source: "action",
    action: "PERSONAL_ASSISTANT",
  });
  return {
    success: true,
    text: responseText,
    data: {
      actionName: "PERSONAL_ASSISTANT",
      action: "sign_document",
      approvalRequestId: request.id,
    },
  };
}

export const personalAssistantAction: Action = {
  name: "PERSONAL_ASSISTANT",
  similes: [
    "ASSISTANT",
    "BOOK_TRAVEL",
    "SCHEDULING",
    "SCHEDULING_NEGOTIATION",
    "SIGN_DOCUMENT",
    "DOCUSIGN",
  ],
  description:
    "Owner personal-assistant workflows. Use action=book_travel for real travel booking, action=scheduling for scheduling negotiation, and action=sign_document for document-signature flows that must be queued for owner approval.",
  descriptionCompressed:
    "personal assistant workflows: action=book_travel|scheduling|sign_document",
  contexts: ["general", "calendar", "travel", "tasks"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async () => true,
  parameters: [
    {
      name: "action",
      description: "Assistant workflow to run.",
      required: true,
      schema: { type: "string" as const, enum: [...PERSONAL_ASSISTANT_ACTIONS] },
    },
  ],
  handler: async (runtime, message, state, options, callback) => {
    const action = readStringParam(options, "action")?.trim().toLowerCase();
    if (action === "book_travel") {
      return delegateHandler(bookTravelAction, runtime, message, state, options, callback);
    }
    if (action === "scheduling") {
      return delegateHandler(
        schedulingNegotiationAction,
        runtime,
        message,
        state,
        options,
        callback,
      );
    }
    if (action === "sign_document") {
      return enqueueDocumentSignatureApproval({
        runtime,
        message,
        options,
        callback,
      });
    }
    return {
      success: false,
      text: "PERSONAL_ASSISTANT requires action=book_travel, action=scheduling, or action=sign_document.",
      data: { error: "MISSING_ACTION" },
    };
  },
};
