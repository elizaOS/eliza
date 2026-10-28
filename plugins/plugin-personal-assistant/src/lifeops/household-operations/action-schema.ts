/**
 * Planner-facing JSON Schema for the nested HOUSEHOLD_OPERATIONS parameters.
 *
 * Mirrors the shapes types.ts normalizes, so the tool schema shows the planner
 * each record, observation, service-event, and signal contract with its enum
 * values, and validateToolArgs rejects a wrong shape before the handler.
 * Cross-field rules (window ordering, provenance authority vs. source kind,
 * coverage evidence, owner acceptance) stay in the domain normalizers.
 */
import type { ActionParameterSchema } from "@elizaos/core";
import {
  HOUSEHOLD_AUTHORITY_CLASSES,
  HOUSEHOLD_OBSERVATION_KINDS,
  HOUSEHOLD_OPPORTUNITY_STATES,
  HOUSEHOLD_RESPONSIBILITY_PHASES,
  HOUSEHOLD_RESPONSIBILITY_SIGNAL_KINDS,
  HOUSEHOLD_SERVICE_EVENT_KINDS,
  HOUSEHOLD_SOURCE_KINDS,
  type HouseholdOperationRecordKind,
} from "./types.js";

type Properties = Record<string, ActionParameterSchema>;

const text = (description?: string): ActionParameterSchema => ({
  type: "string",
  minLength: 1,
  ...(description ? { description } : {}),
});

const timestamp = (description?: string): ActionParameterSchema =>
  text(
    description ? `${description} ISO-8601 timestamp.` : "ISO-8601 timestamp.",
  );

const choice = (
  values: readonly string[],
  description?: string,
): ActionParameterSchema => ({
  type: "string",
  enum: [...values],
  ...(description ? { description } : {}),
});

const strings = (description?: string): ActionParameterSchema => ({
  type: "array",
  items: { type: "string", minLength: 1 },
  ...(description ? { description } : {}),
});

const integer = (minimum: number, maximum?: number): ActionParameterSchema => ({
  type: "integer",
  minimum,
  ...(maximum === undefined ? {} : { maximum }),
});

const number = (minimum: number, maximum: number): ActionParameterSchema => ({
  type: "number",
  minimum,
  maximum,
});

const orNull = (
  schema: ActionParameterSchema,
  description?: string,
): ActionParameterSchema => ({
  anyOf: [schema, { type: "null" }],
  ...(description ? { description } : {}),
});

const nullableText = (description?: string): ActionParameterSchema =>
  orNull({ type: "string", minLength: 1 }, description);

/** Closed object whose every declared property is required unless listed. */
function record(
  properties: Properties,
  options: { optional?: readonly string[]; description?: string } = {},
): ActionParameterSchema {
  const optional = options.optional ?? [];
  return {
    type: "object",
    properties,
    required: Object.keys(properties).filter((key) => !optional.includes(key)),
    additionalProperties: false,
    ...(options.description ? { description: options.description } : {}),
  };
}

const jsonLeaf: ActionParameterSchema[] = [
  { type: "object", additionalProperties: true },
  { type: "string" },
  { type: "number" },
  { type: "boolean" },
  { type: "null" },
];

const visibility: ActionParameterSchema = {
  description: "Who may read this record.",
  anyOf: [
    record({ kind: choice(["owner_private", "household"]) }),
    record({
      kind: choice(["principals"]),
      principalEntityIds: strings("Non-empty."),
    }),
    record({ kind: choice(["child_scoped"]), childEntityId: text() }),
  ],
};

const provenance = record({
  kind: choice(HOUSEHOLD_SOURCE_KINDS),
  sourceId: text(),
  sourceRevision: integer(1),
  observedAt: timestamp(),
  evidenceRef: text(),
  authority: choice(
    HOUSEHOLD_AUTHORITY_CLASSES,
    "Must fit kind: authenticated_user -> user_confirmed; provider_receipt or scheduled_task_state -> provider_confirmed; vendor_receipt -> vendor_provided or provider_confirmed; source_document or photo -> document_extracted; sensor -> sensor_observed; inference -> inferred.",
  ),
  confidence: number(0, 1),
});

const serviceWindow = record({
  startsAt: timestamp(),
  endsAt: timestamp("Must be after startsAt."),
});

function recordVariant(
  kind: HouseholdOperationRecordKind,
  specific: Properties,
  optional: readonly string[] = [],
): ActionParameterSchema {
  return record(
    {
      kind: choice([kind]),
      recordId: text("Stable record identifier."),
      householdId: text(),
      active: { type: "boolean" },
      visibility,
      ...specific,
    },
    { optional, description: `put_record: a ${kind} record.` },
  );
}

const monthDay = record({ month: integer(1, 12), day: integer(1, 31) });
const timezone = text("IANA timezone.");

const RECORD_VARIANTS: ActionParameterSchema[] = [
  recordVariant(
    "vendor_profile",
    {
      vendorEntityId: text("Knowledge-graph entity ID of the vendor."),
      serviceKinds: strings("Non-empty."),
      contactRouteRefs: strings("Non-empty."),
      accessWindows: {
        type: "array",
        items: record(
          {
            daysOfWeek: {
              type: "array",
              items: integer(0, 6),
              description: "Non-empty; 0 is Sunday.",
            },
            localStart: text("24-hour HH:MM."),
            localEnd: text("24-hour HH:MM, after localStart."),
            timezone,
            note: nullableText(),
          },
          { optional: ["note"] },
        ),
      },
      accountReference: nullableText(),
      notes: nullableText(),
    },
    ["accountReference", "notes"],
  ),
  recordVariant(
    "almanac_entry",
    {
      title: text(),
      subjectKey: text(),
      category: choice([
        "maintenance",
        "registration",
        "replacement",
        "family_capacity",
      ]),
      trigger: {
        anyOf: [
          record({
            kind: choice(["annual_window"]),
            opens: monthDay,
            closes: monthDay,
            timezone,
          }),
          record({
            kind: choice(["interval_after_service"]),
            serviceKind: text(),
            afterDays: integer(1, 3_650),
            windowDays: integer(1, 365),
            timezone,
          }),
          record({
            kind: choice(["source_window"]),
            opensAt: timestamp(),
            closesAt: timestamp("Must be after opensAt."),
            timezone,
          }),
        ],
      },
      vendorProfileRecordId: nullableText(),
      responsibilityAssignmentId: nullableText(),
      preparationLeadDays: integer(0, 365),
      sourceObservationIds: strings("May be empty."),
    },
    ["vendorProfileRecordId", "responsibilityAssignmentId"],
  ),
  recordVariant(
    "opportunity",
    {
      title: text(),
      subjectKey: text(),
      subjectEntityIds: strings("Non-empty."),
      almanacEntryRecordId: text(),
      opensAt: timestamp(),
      closesAt: timestamp("Must be after opensAt."),
      state: choice(HOUSEHOLD_OPPORTUNITY_STATES),
      coverageContribution: choice(
        ["none", "confirmed"],
        "confirmed requires state confirmed and confirmationEvidenceRef; state confirmed requires confirmed.",
      ),
      confirmationEvidenceRef: nullableText(),
      plannedStructuredHoursPerWeek: orNull(number(0, 168)),
      capacityPolicy: record({
        preserveUnstructuredTime: { type: "boolean" },
        maximumStructuredHoursPerWeek: orNull(number(0, 168)),
        existingStructuredHoursPerWeek: orNull(number(0, 168)),
        evidenceRefs: strings("May be empty."),
      }),
      proposedEffect: choice([
        "read_only",
        "external_outreach",
        "registration",
      ]),
      approvalRequirement: choice(
        ["none", "owner_approval", "multi_party_approval"],
        "none is only valid when proposedEffect is read_only.",
      ),
      effectIdempotencyKey: text(),
      provenance,
    },
    ["confirmationEvidenceRef"],
  ),
  recordVariant(
    "item_threshold",
    {
      childEntityId: text(),
      itemCategory: text(),
      inventorySubjectKey: nullableText(),
      minimumUsableCount: orNull(integer(0, 10_000)),
      replacementFitStates: {
        type: "array",
        items: choice(["too_small", "damaged"]),
        description: "Non-empty.",
      },
      approvalRequirement: choice(["owner_approval", "multi_party_approval"]),
    },
    ["inventorySubjectKey"],
  ),
  recordVariant(
    "responsibility_assignment",
    {
      subjectKey: text(),
      owners: record({
        conceptionOwnerId: text(),
        planningOwnerId: text(),
        executionOwnerId: text(),
        monitoringOwnerId: text(),
      }),
      minimumStandard: nullableText(),
      acceptedByEntityIds: strings("Must include every owner in owners."),
      startsAt: timestamp(),
      endsAt: orNull(
        { type: "string", minLength: 1 },
        "ISO-8601 timestamp after startsAt, or null when open-ended.",
      ),
      nonUsePolicy: record({
        dismissalThreshold: integer(1, 20),
        overdueThreshold: integer(1, 20),
        evaluationWindowDays: integer(1, 365),
        escalationMode: choice([
          "private_renegotiation",
          "household_conversation",
          "request_acknowledgement",
        ]),
      }),
    },
    ["minimumStandard"],
  ),
];

const OBSERVATION_VARIANT = record(
  {
    householdId: text(),
    subjectKey: text(),
    subjectEntityIds: strings("May be empty."),
    observationKind: choice(HOUSEHOLD_OBSERVATION_KINDS),
    value: {
      description: "value.kind must equal observationKind.",
      anyOf: [
        record({
          kind: choice(["home_state"]),
          state: text(),
          details: {
            description: "Extra JSON detail, or null.",
            anyOf: [...jsonLeaf, { type: "array", items: { anyOf: jsonLeaf } }],
          },
        }),
        record({
          kind: choice(["inventory_level"]),
          quantity: orNull(number(0, 1_000_000)),
          unit: text(),
          state: choice(["confirmed", "estimated", "unknown"]),
        }),
        record(
          {
            kind: choice(["child_item_size"]),
            childEntityId: text(),
            itemCategory: text(),
            sizeLabel: nullableText(),
            fitState: choice([
              "too_small",
              "fits",
              "room_to_grow",
              "damaged",
              "unknown",
            ]),
            measurement: orNull(
              record({ value: number(0, 1_000), unit: choice(["cm", "in"]) }),
            ),
          },
          { optional: ["sizeLabel"] },
        ),
      ],
    },
    provenance,
    visibility,
    supersedesObservationId: nullableText(),
    correctsObservationId: nullableText(),
  },
  {
    optional: ["supersedesObservationId", "correctsObservationId"],
    description: "record_observation: a household observation.",
  },
);

const SERVICE_EVENT_VARIANT = record(
  {
    eventKey: text("Stable key for this service event."),
    householdId: text(),
    subjectKey: text(),
    serviceKind: text(),
    vendorEntityId: nullableText(),
    eventKind: choice(
      HOUSEHOLD_SERVICE_EVENT_KINDS,
      "outreach_sent and scheduled require approvalReference and providerReceiptReference; completed requires completionEvidenceReference.",
    ),
    serviceWindow: orNull(serviceWindow),
    relatedCalendarEventId: nullableText(),
    approvalReference: nullableText(),
    providerReceiptReference: nullableText(),
    completionEvidenceReference: nullableText(),
    provenance,
    visibility,
  },
  {
    optional: [
      "vendorEntityId",
      "relatedCalendarEventId",
      "approvalReference",
      "providerReceiptReference",
      "completionEvidenceReference",
    ],
    description: "record_service_event: a vendor/service-history event.",
  },
);

const RESPONSIBILITY_SIGNAL_VARIANT = record(
  {
    signalKey: text("Stable key for this signal."),
    householdId: text(),
    assignmentRecordId: text(),
    assignmentRevision: integer(1),
    phase: choice(HOUSEHOLD_RESPONSIBILITY_PHASES),
    ownerEntityId: text(),
    signalKind: choice(HOUSEHOLD_RESPONSIBILITY_SIGNAL_KINDS),
    relatedTaskId: nullableText(),
    provenance,
  },
  {
    optional: ["relatedTaskId"],
    description:
      "record_responsibility_signal: a signal for one exact assignment revision.",
  },
);

export const HOUSEHOLD_OPERATION_INPUT_SCHEMA: ActionParameterSchema = {
  anyOf: [
    ...RECORD_VARIANTS,
    OBSERVATION_VARIANT,
    SERVICE_EVENT_VARIANT,
    RESPONSIBILITY_SIGNAL_VARIANT,
  ],
};

export const HOUSEHOLD_BRIEF_WINDOW_SCHEMA = serviceWindow;

export const HOUSEHOLD_CALENDAR_CHECKS_SCHEMA: ActionParameterSchema = {
  type: "array",
  items: record({
    subjectKey: text(),
    window: serviceWindow,
    state: choice(["available", "conflicted", "unknown"]),
    checkedAt: timestamp(),
    sourceRefs: strings(
      "Calendar sources consulted; must be non-empty when state is available.",
    ),
    conflictRefs: strings("May be empty."),
  }),
};
