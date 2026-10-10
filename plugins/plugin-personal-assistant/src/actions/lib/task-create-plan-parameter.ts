import type { ActionParameter, ActionParameterSchema } from "@elizaos/core";
import { validateSchema } from "@elizaos/core";
import {
  buildTaskCreatePlan,
  type ExtractedTaskCreatePlan,
  NATIVE_PROJECTION_GUIDANCE,
} from "./extract-task-plan.js";
import { UNDATED_TODO_EXTRACTION_GUIDANCE } from "./undated-todo-intent.js";

// The native planner and fallback extractor share the same semantic plan.
// Omitted tool fields normalize to the extractor's unknown (null) values.
// Keep this on definition CREATE only: reads/deletes/goals do not consume it.
const properties = {
  mode: { type: "string" as const, enum: ["create", "respond"] },
  response: { type: "string" as const, minLength: 1 },
  requestKind: {
    type: "string" as const,
    enum: ["alarm", "reminder", "unspecified"],
  },
  nativeProjection: {
    anyOf: [
      { type: "string" as const, enum: ["in_app_only", "apple_reminders"] },
      { type: "null" as const },
    ],
  },
  title: { type: "string" as const, minLength: 1 },
  description: {
    description:
      "For reminders, copy the owner-requested alert body verbatim; use null when no separate body was requested. Do not put delivery or scheduling instructions in the body. For other task kinds, retain brief owner-provided context.",
    anyOf: [
      { type: "string" as const, minLength: 1 },
      { type: "null" as const },
    ],
  },
  cadenceKind: {
    type: "string" as const,
    enum: [
      "unscheduled",
      "once",
      "daily",
      "weekly",
      "times_per_day",
      "count_per_day",
      "interval",
    ],
  },
  windows: {
    type: "array" as const,
    items: { type: "string" as const, minLength: 1 },
  },
  weekdays: {
    type: "array" as const,
    items: { type: "integer" as const, minimum: 0, maximum: 6 },
  },
  timeOfDay: {
    type: "string" as const,
    pattern: "^(?:[01]?[0-9]|2[0-3]):[0-5][0-9]$",
  },
  timeZone: { type: "string" as const, minLength: 1 },
  everyMinutes: { type: "number" as const, minimum: 1 },
  timesPerDay: { type: "integer" as const, minimum: 1 },
  quotaTargetCount: { type: "number" as const, minimum: 1 },
  quotaUnit: { type: "string" as const, minLength: 1 },
  perOccurrenceWork: { type: "string" as const, minLength: 1 },
  checkInRequested: { type: "boolean" as const },
  checkInWindows: {
    type: "array" as const,
    items: { type: "string" as const, minLength: 1 },
  },
  priority: { type: "integer" as const, minimum: 1, maximum: 5 },
  durationMinutes: { type: "number" as const, minimum: 1 },
  dueDate: {
    anyOf: [
      { type: "string" as const, pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
      { type: "null" as const },
    ],
  },
  dueInDays: {
    anyOf: [
      { type: "integer" as const, minimum: 0 },
      { type: "null" as const },
    ],
  },
  dueWeekday: {
    anyOf: [
      { type: "integer" as const, minimum: 0, maximum: 6 },
      { type: "null" as const },
    ],
  },
  dueInMinutes: {
    anyOf: [{ type: "number" as const, minimum: 1 }, { type: "null" as const }],
  },
  multiStep: { type: "boolean" as const },
} satisfies Record<string, ActionParameterSchema>;

// Strict providers require every object branch to declare its complete closed
// property set. Reuse definitions while discriminating each mode's minimum.
const schema = {
  anyOf: [
    {
      type: "object" as const,
      additionalProperties: false,
      required: [
        "mode",
        "multiStep",
        "requestKind",
        "title",
        "description",
        "cadenceKind",
        "nativeProjection",
        "dueDate",
        "dueInDays",
        "dueWeekday",
        "dueInMinutes",
      ],
      properties: {
        ...properties,
        mode: { type: "string" as const, enum: ["create"] },
      },
    },
    {
      type: "object" as const,
      additionalProperties: false,
      required: ["mode", "multiStep", "requestKind", "response"],
      properties: {
        ...properties,
        mode: { type: "string" as const, enum: ["respond"] },
      },
    },
  ],
} satisfies ActionParameterSchema;

export const TASK_CREATE_PLAN_PARAMETER: ActionParameter = {
  name: "createPlan",
  required: false,
  subactions: ["create"],
  requiredForSubactions: ["create"],
  // Semantics the field names, enums, patterns and required lists above do not
  // already carry. Every OWNER_* definition tool offers this parameter, so its
  // weight repeats per turn; restating the schema here only adds tokens.
  description: [
    "Semantic plan for this definition create from the whole current owner request, any language; recent conversation only resolves short follow-ups. The owner's full request goes in intent, not duplicated in title/details. The umbrella may omit createPlan when context is unavailable.",
    'mode=create whenever what to track and when are given, even for "preview the plan" or "don\'t save yet": the plan never grants permission to save or confirm a pending draft; the handler applies consent and draft rules. mode=respond (a short clarifying response; omit cadenceKind and every due/time field) only when what or when is missing or the owner says not to guess it; never invent a task or schedule. Omit other unknown fields.',
    "- requestKind: alarm or reminder only when explicitly requested; otherwise unspecified. title: 2-5 words.",
    // Required and nullable in the schema. Stated here as well because the
    // body must stay independent of title, which the field text does not say.
    "- description: always include it for mode=create. Copy an explicit requested reminder body exactly, independently of the title; use null when no separate alert body was requested. Do not silently reduce an explicit body to the title or put delivery instructions in it.",
    `- nativeProjection: ${NATIVE_PROJECTION_GUIDANCE}`,
    '- cadenceKind: once = a single date and/or clock time without a recurrence word; a deadline ("by the 20th", "before Friday") is once on that date, never a reason to ask for a time. weekly = named weekdays; times_per_day = only explicitly named clock times; count_per_day = a count quota without invented clock slots.',
    UNDATED_TODO_EXTRACTION_GUIDANCE,
    "- windows: wake up/before work -> morning, lunch -> afternoon, after work/dinner -> evening, before bed -> night. weekdays and dueWeekday: 0=Sun..6=Sat. timeZone: only an IANA zone the owner names.",
    '- "25 pushups, 3 sets a day": quotaTargetCount 3, quotaUnit "set", perOccurrenceWork "25 pushups". checkInRequested: true only when asked to be nudged about remaining quota progress, false when declined; checkInWindows: windows allowed for those nudges.',
    "- priority: 1 critical, 2 high, 3 medium, 4-5 low.",
    '- Due selectors (mode=create): at most one, only for once, from the current date in context; null otherwise, all four for recurring or clock-only tasks. dueDate: a named date\'s next occurrence; dueInDays: today 0, tomorrow 1; dueWeekday: a named weekday; dueInMinutes: an offset ("in 2 hours" -> 120).',
    "- multiStep: true when the request covers more than one distinct task or milestone.",
  ].join("\n"),
  schema,
};

/** Validate direct callers too; malformed/partial plans keep normal extraction. */
export function parseNativeTaskCreatePlan(
  value: unknown,
): ExtractedTaskCreatePlan | null {
  if (value === undefined) return null;
  const errors: string[] = [];
  // Existing direct callers may omit unknown selectors. Normalize only these
  // unknowns; never invent a schedule. Native tools require explicit choices.
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const input = record
    ? {
        ...record,
        dueDate: record.dueDate ?? null,
        dueInDays: record.dueInDays ?? null,
        dueWeekday: record.dueWeekday ?? null,
        dueInMinutes: record.dueInMinutes ?? null,
      }
    : value;
  const validated = validateSchema(schema, input, "createPlan", errors);
  if (
    errors.length ||
    !validated ||
    typeof validated !== "object" ||
    Array.isArray(validated)
  )
    return null;
  const plan = buildTaskCreatePlan(validated as Record<string, unknown>);
  if (!plan || (plan.mode === "create" && (!plan.title || !plan.cadenceKind)))
    return null;
  // An omitted destination cannot certify a complete native timed reminder:
  // existing extraction must recover the owner's destination before defaults.
  if (
    plan.mode === "create" &&
    plan.cadenceKind === "once" &&
    (plan.requestKind === "alarm" || plan.requestKind === "reminder") &&
    plan.nativeProjection === null
  )
    return null;
  // Do not silently discard an explicit invalid timezone/date before applying
  // the owner's fallback zone or resolving relative dates.
  const raw = validated as Record<string, unknown>;
  if (
    (raw.timeZone !== undefined && !plan.timeZone) ||
    (raw.dueDate != null && !plan.dueDate)
  )
    return null;
  const dateFields = [
    plan.dueDate,
    plan.dueInDays,
    plan.dueWeekday,
    plan.dueInMinutes,
  ].filter((field) => field !== null);
  if (
    dateFields.length > 1 ||
    (plan.cadenceKind !== "once" && dateFields.length > 0) ||
    (plan.mode === "create" &&
      plan.cadenceKind === "once" &&
      dateFields.length === 0 &&
      !plan.timeOfDay &&
      !plan.windows?.length)
  )
    return null;
  return plan;
}
