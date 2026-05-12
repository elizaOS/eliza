import type {
  Action,
  ActionParameters,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { createApprovalQueue } from "../lifeops/approval-queue.js";
import { runBookTravelHandler } from "./book-travel.js";
import {
  HEALTH_PARAMETERS,
  HEALTH_SIMILES,
  runHealthHandler,
} from "./health.js";
import { runSchedulingNegotiationHandler } from "./lib/scheduling-handler.js";
import {
  OWNER_OPERATION_CONTEXTS,
  OWNER_OPERATION_ROLE_GATE,
  OWNER_OPERATION_SUPPRESS_POST_ACTION_CONTINUATION,
  OWNER_OPERATION_TAGS,
  OWNER_OPERATION_VALIDATE,
  runLifeOperationHandler,
} from "./life.js";
import {
  MONEY_PARAMETERS,
  OWNER_FINANCE_SIMILES,
  runMoneyHandler,
} from "./money.js";
import { runScheduleHandler } from "./schedule.js";
import {
  runScreenTimeHandler,
  SCREEN_TIME_PARAMETERS,
  SCREEN_TIME_SIMILES,
} from "./screen-time.js";

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

function readParameters(options: unknown): ActionParameters {
  if (!options || typeof options !== "object") return {};
  const record = options as Record<string, unknown>;
  const params = record.parameters;
  if (params && typeof params === "object" && !Array.isArray(params)) {
    return { ...(params as ActionParameters) };
  }
  return { ...(record as ActionParameters) };
}

function withParameters(
  options: unknown,
  parameters: ActionParameters,
): HandlerOptions {
  if (!options || typeof options !== "object") {
    return { parameters };
  }
  const record = options as HandlerOptions;
  return {
    ...record,
    parameters,
  };
}

function mirrorActionToSubaction(options: unknown): HandlerOptions {
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
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  return allowed.includes(normalized as TAction)
    ? (normalized as TAction)
    : undefined;
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
    tags: OWNER_OPERATION_TAGS,
    contexts: OWNER_OPERATION_CONTEXTS,
    roleGate: OWNER_OPERATION_ROLE_GATE,
    suppressPostActionContinuation: OWNER_OPERATION_SUPPRESS_POST_ACTION_CONTINUATION,
    validate: OWNER_OPERATION_VALIDATE,
    parameters: [
      {
        name: "action",
        description: `Owner item operation: ${allowedActions.join(", ")}.`,
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
        description:
          "Existing item id or title for update/delete/complete/skip/snooze/review.",
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
        description:
          "Structured schedule, cadence, notes, or other extracted details.",
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
      return runLifeOperationHandler(
        runtime,
        message,
        state,
        withParameters(options, merged),
        callback,
      );
    },
  };
}

export const ownerRemindersAction: Action = {
  ...makeOwnerLifeAction({
    name: "OWNER_REMINDERS",
    similes: [
      "REMINDER",
      "REMINDERS",
      "SET_REMINDER",
      "REMIND_ME",
      "REMIND_ME_TO",
    ],
    description:
      "Owner reminders: create, update, delete, complete, skip, snooze, or review one-off and recurring reminders.",
    descriptionCompressed:
      "owner reminders: action=create|update|delete|complete|skip|snooze|review",
    defaultKind: "definition",
  }),
  name: "OWNER_REMINDERS",
  similes: [
    "REMINDER",
    "REMINDERS",
    "SET_REMINDER",
    "REMIND_ME",
    "REMIND_ME_TO",
  ],
  description:
    "Owner reminders: create, update, delete, complete, skip, snooze, or review one-off and recurring reminders.",
  descriptionCompressed:
    "owner reminders: action=create|update|delete|complete|skip|snooze|review",
};

export const ownerAlarmsAction: Action = {
  ...makeOwnerLifeAction({
    name: "OWNER_ALARMS",
    similes: ["ALARM", "ALARMS", "WAKE_ME", "WAKE_UP"],
    description:
      "Owner alarms: create, update, delete, complete, skip, snooze, or review alarm-like reminders.",
    descriptionCompressed:
      "owner alarms: action=create|update|delete|complete|skip|snooze|review",
    defaultKind: "definition",
  }),
  name: "OWNER_ALARMS",
  similes: ["ALARM", "ALARMS", "WAKE_ME", "WAKE_UP"],
  description:
    "Owner alarms: create, update, delete, complete, skip, snooze, or review alarm-like reminders.",
  descriptionCompressed:
    "owner alarms: action=create|update|delete|complete|skip|snooze|review",
};

export const ownerGoalsAction: Action = {
  ...makeOwnerLifeAction({
    name: "OWNER_GOALS",
    similes: ["GOAL", "GOALS", "LONG_TERM_GOAL"],
    description:
      "Owner goals: create, update, delete, or review long-term goals and progress.",
    descriptionCompressed:
      "owner goals: action=create|update|delete|review; backing kind=goal",
    defaultKind: "goal",
    actions: [...OWNER_GOAL_ACTIONS],
  }),
  name: "OWNER_GOALS",
  similes: ["GOAL", "GOALS", "LONG_TERM_GOAL"],
  description:
    "Owner goals: create, update, delete, or review long-term goals and progress.",
  descriptionCompressed:
    "owner goals: action=create|update|delete|review; backing kind=goal",
};

// Owner-store todos surface. Backed by the app-lifeops owner definitions store
// (with kind=definition occurrence tracking). The general-purpose planner
// surface — backed by @elizaos/core TodosService — is TODO in
// plugins/plugin-todos/src/actions/todo.ts. The two surfaces target different
// stores and must not be merged.
export const ownerTodosAction: Action = {
  ...makeOwnerLifeAction({
    name: "OWNER_TODOS",
    similes: [
      "OWNER_TODO",
      "PERSONAL_TODO",
      "PERSONAL_TODOS",
      "PERSONAL_TASK",
    ],
    description:
      "Owner todos: create, update, delete, complete, skip, snooze, or review personal todos.",
    descriptionCompressed:
      "owner todos: action=create|update|delete|complete|skip|snooze|review",
    defaultKind: "definition",
  }),
  name: "OWNER_TODOS",
  similes: [
    "OWNER_TODO",
    "PERSONAL_TODO",
    "PERSONAL_TODOS",
    "PERSONAL_TASK",
  ],
  description:
    "Owner todos: create, update, delete, complete, skip, snooze, or review personal todos.",
  descriptionCompressed:
    "owner todos: action=create|update|delete|complete|skip|snooze|review",
};

const OWNER_ROUTINE_ACTIONS = [
  ...OWNER_LIFE_ACTIONS,
  "schedule_summary",
  "schedule_inspect",
] as const;

type OwnerRoutineAction = (typeof OWNER_ROUTINE_ACTIONS)[number];

function normalizeOwnerRoutineAction(
  options: unknown,
): OwnerRoutineAction | undefined {
  const raw =
    readStringParam(options, "action") ??
    readStringParam(options, "subaction") ??
    readStringParam(options, "op") ??
    readStringParam(options, "operation");
  if (!raw) return undefined;
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  return (OWNER_ROUTINE_ACTIONS as readonly string[]).includes(normalized)
    ? (normalized as OwnerRoutineAction)
    : undefined;
}

export const ownerRoutinesAction: Action = {
  ...makeOwnerLifeAction({
    name: "OWNER_ROUTINES",
    similes: [
      "HABIT",
      "HABITS",
      "ROUTINE",
      "ROUTINES",
      "DAILY_TASK",
      "WEEKLY_TASK",
    ],
    description:
      "Owner routines and habits: create or manage recurring routines, and inspect passive schedule inference.",
    descriptionCompressed:
      "owner routines: action=create|update|delete|complete|skip|snooze|review|schedule_summary|schedule_inspect",
    defaultKind: "definition",
  }),
  name: "OWNER_ROUTINES",
  similes: [
    "HABIT",
    "HABITS",
    "ROUTINE",
    "ROUTINES",
    "DAILY_TASK",
    "WEEKLY_TASK",
  ],
  description:
    "Owner routines and habits: create or manage recurring routines, and inspect passive schedule inference.",
  descriptionCompressed:
    "owner routines: action=create|update|delete|complete|skip|snooze|review|schedule_summary|schedule_inspect",
  parameters: [
    {
      name: "action",
      description:
        "Routine operation: create, update, delete, complete, skip, snooze, review, schedule_summary, or schedule_inspect.",
      required: false,
      schema: { type: "string" as const, enum: [...OWNER_ROUTINE_ACTIONS] },
    },
    ...(
      makeOwnerLifeAction({
        name: "OWNER_ROUTINES",
        similes: [],
        description: "",
        descriptionCompressed: "",
        defaultKind: "definition",
      }).parameters ?? []
    ).filter((parameter) => parameter.name !== "action"),
  ],
  handler: async (runtime, message, state, options, callback) => {
    const action = normalizeOwnerRoutineAction(options);
    if (action === "schedule_summary" || action === "schedule_inspect") {
      const params = {
        ...readParameters(options),
        subaction: action === "schedule_inspect" ? "inspect" : "summary",
      };
      return runScheduleHandler(
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
    return runLifeOperationHandler(
      runtime,
      message,
      state,
      withParameters(options, merged),
      callback,
    );
  },
};

export const ownerHealthAction: Action = {
  name: "OWNER_HEALTH",
  similes: ["HEALTH", "FITNESS", "WELLNESS", ...HEALTH_SIMILES],
  description:
    "Owner health telemetry reads across HealthKit, Google Fit, Strava, Fitbit, Withings, or Oura. Actions: today, trend, by_metric, status.",
  descriptionCompressed:
    "owner health: today|trend|by_metric|status; read-only telemetry",
  routingHint:
    'owner health/wearable reads ("step count", "sleep last night", heart rate, workouts) -> OWNER_HEALTH',
  parameters: [
    {
      name: "action",
      description:
        "Owner health read action: today, trend, by_metric, or status.",
      required: false,
      schema: { type: "string" as const, enum: [...OWNER_HEALTH_ACTIONS] },
    },
    ...HEALTH_PARAMETERS.filter((parameter) => parameter.name !== "subaction"),
  ],
  validate: OWNER_OPERATION_VALIDATE,
  handler: (runtime, message, state, options, callback) =>
    runHealthHandler(
      runtime,
      message,
      state,
      mirrorActionToSubaction(options),
      callback,
    ),
};

export const ownerScreenTimeAction: Action = {
  name: "OWNER_SCREENTIME",
  similes: [
    "SCREENTIME",
    "SCREEN_TIME",
    "ACTIVITY_REPORT",
    ...SCREEN_TIME_SIMILES,
  ],
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
    ...SCREEN_TIME_PARAMETERS.filter(
      (parameter) => parameter.name !== "subaction",
    ),
  ],
  validate: OWNER_OPERATION_VALIDATE,
  handler: (runtime, message, state, options, callback) =>
    runScreenTimeHandler(
      runtime,
      message,
      state,
      mirrorActionToSubaction(options),
      callback,
    ),
};

export const ownerFinancesAction: Action = {
  name: "OWNER_FINANCES",
  similes: ["FINANCES", ...OWNER_FINANCE_SIMILES],
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
    ...MONEY_PARAMETERS.filter((parameter) => parameter.name !== "subaction"),
  ],
  validate: OWNER_OPERATION_VALIDATE,
  handler: (runtime, message, state, options, _callback) =>
    runMoneyHandler(runtime, message, state, mirrorActionToSubaction(options)),
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
    "SCHEDULING",
    "SIGN_DOCUMENT",
    "DOCUSIGN",
    // PRD action-catalog aliases. Travel workflows resolve to action=book_travel
    // on PERSONAL_ASSISTANT.
    // See packages/docs/action-prd-map.md.
    "TRAVEL_CAPTURE_PREFERENCES",
    "TRAVEL_BOOK_FLIGHT",
    "TRAVEL_BOOK_HOTEL",
    "TRAVEL_SYNC_ITINERARY_TO_CALENDAR",
    "TRAVEL_REBOOK_AFTER_CONFLICT",
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
      schema: {
        type: "string" as const,
        enum: [...PERSONAL_ASSISTANT_ACTIONS],
      },
    },
  ],
  handler: async (runtime, message, state, options, callback) => {
    const action = readStringParam(options, "action")?.trim().toLowerCase();
    if (action === "book_travel") {
      return runBookTravelHandler(
        runtime,
        message,
        state,
        options,
        callback,
      );
    }
    if (action === "scheduling") {
      return runSchedulingNegotiationHandler(
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
