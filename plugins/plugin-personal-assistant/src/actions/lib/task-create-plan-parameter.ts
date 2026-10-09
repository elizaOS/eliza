import type { ActionParameter, ActionParameterSchema } from "@elizaos/core";
import { validateSchema } from "@elizaos/core";
import {
  buildTaskCreatePlan,
  type ExtractedTaskCreatePlan,
  taskCreatePlanGuidance,
} from "./extract-task-plan.js";

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
  description: [
    "For a definition create, supply the complete semantic plan here using the current owner request and relevant conversation already in context. This avoids a second interpretation call. Use intent for the owner's full request; do not duplicate this plan in title/details. The parent umbrella may omit createPlan when necessary context is unavailable; promoted CREATE requires it. Use the existing mode=respond plan for clarification when the title or timing cannot be established, without guessing. Unknown nativeProjection remains null and follows the existing safe extraction path. This plan never grants permission to save or confirm a pending draft; the handler applies owner consent and draft rules.",
    "Always include mode, multiStep and requestKind. For mode=create include title, description and cadenceKind; for mode=respond include response. Use requestKind=unspecified only when neither alarm nor reminder is explicit. For mode=create, always include nativeProjection; use null for an unknown destination. For mode=create, always include dueDate, dueInDays, dueWeekday and dueInMinutes: fill the applicable selector from the owner's request and use null for the others. A relative minute/hour offset belongs in dueInMinutes. Always include description: copy an explicit requested reminder body exactly, independently of the title; use null when no separate alert body was requested. Do not silently reduce an explicit body to the title or put delivery instructions in it. Omit other unknown/inapplicable fields. Use the current date/time in context for date grounding; retain relative date fields when applicable.",
    taskCreatePlanGuidance(true),
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
