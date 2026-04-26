import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { CreateLifeOpsCalendarEventRequest } from "../contracts/index.js";
import type {
  AddPaymentSourceRequest,
  LifeOpsPaymentSourceKind,
} from "../lifeops/payment-types.js";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import { extractActionParamsViaLlm } from "@elizaos/agent";
import { hasLifeOpsAccess, INTERNAL_URL } from "./lifeops-google-helpers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MutateSubaction =
  | "gmail_reply"
  | "gmail_manage"
  | "mark_read"
  | "calendar_create"
  | "calendar_update"
  | "calendar_delete"
  | "reminder_snooze"
  | "reminder_complete"
  | "reminder_create"
  | "payment_source_add"
  | "payment_source_delete"
  | "payment_csv_import"
  | "unsubscribe_sender";

type MutateActionParams = {
  subaction?: MutateSubaction;

  // gmail_reply
  messageId?: string;
  bodyText?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  confirmSend?: boolean;

  // gmail_manage
  operation?:
    | "archive"
    | "trash"
    | "delete"
    | "report_spam"
    | "mark_read"
    | "mark_unread"
    | "apply_label"
    | "remove_label";
  messageIds?: string[];
  query?: string;
  maxResults?: number;
  labelIds?: string[];
  confirmDestructive?: boolean;

  // mark_read (inbox-level)
  inboxEntryId?: string;

  // calendar_*
  eventId?: string;
  calendarId?: string;
  title?: string;
  description?: string;
  location?: string;
  startAt?: string;
  endAt?: string;
  timeZone?: string;
  attendees?: { email: string; displayName?: string; optional?: boolean }[];

  // reminder_snooze
  occurrenceId?: string;
  minutes?: number;
  preset?: "15m" | "30m" | "1h" | "tonight" | "tomorrow_morning";

  // reminder_complete
  note?: string;

  // payment_source_add
  kind?: LifeOpsPaymentSourceKind;
  label?: string;
  institution?: string | null;
  accountMask?: string | null;

  // payment_source_delete
  sourceId?: string;

  // payment_csv_import
  csvText?: string;
  dateColumn?: string;
  amountColumn?: string;
  merchantColumn?: string;
  descriptionColumn?: string;
  categoryColumn?: string;

  // unsubscribe_sender
  senderEmail?: string;
  listId?: string | null;
  blockAfter?: boolean;
  trashExisting?: boolean;
  confirmed?: boolean;

  // pass-through connector hints
  side?: "owner" | "agent";
  mode?: "local" | "cloud_managed" | "remote";
  grantId?: string;
};

const ACTION_NAME = "LIFEOPS_MUTATE";

const VALID_SUBACTIONS: readonly MutateSubaction[] = [
  "gmail_reply",
  "gmail_manage",
  "mark_read",
  "calendar_create",
  "calendar_update",
  "calendar_delete",
  "reminder_snooze",
  "reminder_complete",
  "reminder_create",
  "payment_source_add",
  "payment_source_delete",
  "payment_csv_import",
  "unsubscribe_sender",
];

function normalizeSubaction(value: unknown): MutateSubaction | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[- ]/g, "_");
  return (VALID_SUBACTIONS as readonly string[]).includes(normalized)
    ? (normalized as MutateSubaction)
    : null;
}

function mergeParams(
  message: Memory,
  options?: HandlerOptions,
): MutateActionParams {
  const params = {
    ...(((options as Record<string, unknown> | undefined)?.parameters ??
      {}) as Record<string, unknown>),
  };
  if (message.content && typeof message.content === "object") {
    for (const [key, value] of Object.entries(
      message.content as Record<string, unknown>,
    )) {
      if (params[key] === undefined) {
        params[key] = value;
      }
    }
  }
  return params as MutateActionParams;
}

function notImplemented(
  subaction: MutateSubaction,
  detail?: string,
): ActionResult {
  const text =
    `[${ACTION_NAME}] ${subaction} is not yet implemented in the agent action layer.` +
    (detail ? ` ${detail}` : "");
  return {
    success: false,
    text,
    data: {
      actionName: ACTION_NAME,
      subaction,
      error: "NOT_IMPLEMENTED",
    },
  };
}

function missingParamResult(
  subaction: MutateSubaction,
  missing: string[],
): ActionResult {
  return {
    success: false,
    text: `[${ACTION_NAME}] ${subaction} requires: ${missing.join(", ")}.`,
    data: {
      actionName: ACTION_NAME,
      subaction,
      error: "MISSING_PARAMS",
      missing,
    },
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatchGmailReply(
  service: LifeOpsService,
  params: MutateActionParams,
): Promise<ActionResult> {
  if (!params.messageId || !params.bodyText) {
    return missingParamResult("gmail_reply", [
      ...(!params.messageId ? ["messageId"] : []),
      ...(!params.bodyText ? ["bodyText"] : []),
    ]);
  }
  const result = await service.sendGmailReply(INTERNAL_URL, {
    mode: params.mode,
    side: params.side,
    grantId: params.grantId,
    messageId: params.messageId,
    bodyText: params.bodyText,
    to: params.to,
    cc: params.cc,
    subject: params.subject,
    confirmSend: params.confirmSend ?? true,
  });
  return {
    success: true,
    text: `Gmail reply sent to messageId=${params.messageId}.`,
    data: {
      actionName: ACTION_NAME,
      subaction: "gmail_reply",
      result,
    },
  };
}

async function dispatchGmailManage(
  service: LifeOpsService,
  params: MutateActionParams,
): Promise<ActionResult> {
  if (!params.operation) {
    return missingParamResult("gmail_manage", ["operation"]);
  }
  const messageIds = params.messageIds ?? [];
  if (messageIds.length === 0 && !params.query) {
    return missingParamResult("gmail_manage", ["messageIds | query"]);
  }
  const result = await service.manageGmailMessages(INTERNAL_URL, {
    mode: params.mode,
    side: params.side,
    grantId: params.grantId,
    operation: params.operation,
    messageIds: messageIds.length > 0 ? messageIds : undefined,
    query: messageIds.length === 0 ? params.query : undefined,
    maxResults: params.maxResults ?? 10,
    labelIds: params.labelIds,
    confirmDestructive: params.confirmDestructive ?? false,
  });
  return {
    success: true,
    text: `Updated ${result.affectedCount} Gmail message${result.affectedCount === 1 ? "" : "s"} (${params.operation}).`,
    data: {
      actionName: ACTION_NAME,
      subaction: "gmail_manage",
      result,
    },
  };
}

function dispatchMarkRead(): ActionResult {
  return notImplemented(
    "mark_read",
    "LifeOpsService does not yet expose a mark-read mutation for inbox entries (lastSeenAt is updated by passive read paths). Add markInboxEntryRead to LifeOpsService before wiring this subaction.",
  );
}

async function dispatchCalendarCreate(
  service: LifeOpsService,
  params: MutateActionParams,
): Promise<ActionResult> {
  if (!params.title) {
    return missingParamResult("calendar_create", ["title"]);
  }
  if (!params.startAt || !params.endAt) {
    return missingParamResult("calendar_create", [
      ...(!params.startAt ? ["startAt"] : []),
      ...(!params.endAt ? ["endAt"] : []),
    ]);
  }
  const request = {
    mode: params.mode,
    side: params.side,
    grantId: params.grantId,
    calendarId: params.calendarId,
    title: params.title,
    description: params.description,
    location: params.location,
    startAt: params.startAt,
    endAt: params.endAt,
    timeZone: params.timeZone,
    attendees: params.attendees,
  } as CreateLifeOpsCalendarEventRequest;
  const event = await service.createCalendarEvent(INTERNAL_URL, request);
  return {
    success: true,
    text: `Calendar event "${event.title}" created (id=${event.id}).`,
    data: { actionName: ACTION_NAME, subaction: "calendar_create", event },
  };
}

async function dispatchCalendarUpdate(
  service: LifeOpsService,
  params: MutateActionParams,
): Promise<ActionResult> {
  if (!params.eventId) {
    return missingParamResult("calendar_update", ["eventId"]);
  }
  const event = await service.updateCalendarEvent(INTERNAL_URL, {
    mode: params.mode,
    side: params.side,
    grantId: params.grantId,
    calendarId: params.calendarId,
    eventId: params.eventId,
    title: params.title,
    description: params.description,
    location: params.location,
    startAt: params.startAt,
    endAt: params.endAt,
    timeZone: params.timeZone,
    attendees: params.attendees,
  });
  return {
    success: true,
    text: `Calendar event "${event.title}" updated.`,
    data: { actionName: ACTION_NAME, subaction: "calendar_update", event },
  };
}

async function dispatchCalendarDelete(
  service: LifeOpsService,
  params: MutateActionParams,
): Promise<ActionResult> {
  if (!params.eventId) {
    return missingParamResult("calendar_delete", ["eventId"]);
  }
  await service.deleteCalendarEvent(INTERNAL_URL, {
    mode: params.mode,
    side: params.side,
    grantId: params.grantId,
    calendarId: params.calendarId,
    eventId: params.eventId,
  });
  return {
    success: true,
    text: `Calendar event ${params.eventId} deleted.`,
    data: {
      actionName: ACTION_NAME,
      subaction: "calendar_delete",
      eventId: params.eventId,
    },
  };
}

async function dispatchReminderSnooze(
  service: LifeOpsService,
  params: MutateActionParams,
): Promise<ActionResult> {
  if (!params.occurrenceId) {
    return missingParamResult("reminder_snooze", ["occurrenceId"]);
  }
  const view = await service.snoozeOccurrence(params.occurrenceId, {
    minutes: params.minutes,
    preset: params.preset,
  });
  return {
    success: true,
    text: `Snoozed "${view.title}" until ${view.snoozedUntil ?? "later"}.`,
    data: { actionName: ACTION_NAME, subaction: "reminder_snooze", view },
  };
}

async function dispatchReminderComplete(
  service: LifeOpsService,
  params: MutateActionParams,
): Promise<ActionResult> {
  if (!params.occurrenceId) {
    return missingParamResult("reminder_complete", ["occurrenceId"]);
  }
  const view = await service.completeOccurrence(params.occurrenceId, {
    note: params.note,
  });
  return {
    success: true,
    text: `Marked "${view.title}" complete.`,
    data: { actionName: ACTION_NAME, subaction: "reminder_complete", view },
  };
}

function dispatchReminderCreate(): ActionResult {
  return notImplemented(
    "reminder_create",
    "Reminder creation today goes through the LIFE action's intent extraction pipeline. A direct service-level createReminder is not exposed yet — wire LIFE delegate or add a service method in a follow-up wave.",
  );
}

async function dispatchPaymentSourceAdd(
  service: LifeOpsService,
  params: MutateActionParams,
): Promise<ActionResult> {
  if (!params.kind || !params.label) {
    return missingParamResult("payment_source_add", [
      ...(!params.kind ? ["kind"] : []),
      ...(!params.label ? ["label"] : []),
    ]);
  }
  const request: AddPaymentSourceRequest = {
    kind: params.kind,
    label: params.label,
    institution: params.institution ?? null,
    accountMask: params.accountMask ?? null,
  };
  const source = await service.addPaymentSource(request);
  return {
    success: true,
    text: `Added ${source.kind} payment source "${source.label}".`,
    data: { actionName: ACTION_NAME, subaction: "payment_source_add", source },
  };
}

async function dispatchPaymentSourceDelete(
  service: LifeOpsService,
  params: MutateActionParams,
): Promise<ActionResult> {
  if (!params.sourceId) {
    return missingParamResult("payment_source_delete", ["sourceId"]);
  }
  await service.deletePaymentSource(params.sourceId);
  return {
    success: true,
    text: `Payment source ${params.sourceId} removed.`,
    data: {
      actionName: ACTION_NAME,
      subaction: "payment_source_delete",
      sourceId: params.sourceId,
    },
  };
}

async function dispatchPaymentCsvImport(
  service: LifeOpsService,
  params: MutateActionParams,
): Promise<ActionResult> {
  if (!params.sourceId || !params.csvText) {
    return missingParamResult("payment_csv_import", [
      ...(!params.sourceId ? ["sourceId"] : []),
      ...(!params.csvText ? ["csvText"] : []),
    ]);
  }
  const result = await service.importTransactionsCsv({
    sourceId: params.sourceId,
    csvText: params.csvText,
    dateColumn: params.dateColumn,
    amountColumn: params.amountColumn,
    merchantColumn: params.merchantColumn,
    descriptionColumn: params.descriptionColumn,
    categoryColumn: params.categoryColumn,
  });
  return {
    success: result.errors.length === 0 || result.inserted > 0,
    text: `Imported ${result.inserted} transaction${result.inserted === 1 ? "" : "s"} (${result.skipped} skipped, ${result.errors.length} error${result.errors.length === 1 ? "" : "s"}).`,
    data: { actionName: ACTION_NAME, subaction: "payment_csv_import", result },
  };
}

async function dispatchUnsubscribeSender(
  service: LifeOpsService,
  params: MutateActionParams,
): Promise<ActionResult> {
  if (!params.senderEmail) {
    return missingParamResult("unsubscribe_sender", ["senderEmail"]);
  }
  const result = await service.unsubscribeEmailSender(INTERNAL_URL, {
    senderEmail: params.senderEmail,
    listId: params.listId ?? null,
    blockAfter: params.blockAfter ?? true,
    trashExisting: params.trashExisting ?? false,
    confirmed: params.confirmed ?? true,
  });
  return {
    success:
      result.record.status === "succeeded" ||
      result.record.status === "manual_required",
    text: service.summarizeEmailUnsubscribeResult(result),
    data: {
      actionName: ACTION_NAME,
      subaction: "unsubscribe_sender",
      record: result.record,
    },
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const lifeOpsMutateAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "LIFEOPS_DO",
    "LIFEOPS_WRITE",
    "LIFEOPS_UPDATE",
    "GMAIL_SEND_REPLY",
    "GMAIL_MANAGE_MESSAGES",
    "MARK_INBOX_READ",
    "CALENDAR_CREATE_EVENT",
    "CALENDAR_UPDATE_EVENT",
    "CALENDAR_DELETE_EVENT",
    "REMINDER_SNOOZE",
    "REMINDER_COMPLETE",
    "PAYMENTS_ADD_SOURCE",
    "PAYMENTS_DELETE_SOURCE",
    "PAYMENTS_IMPORT_CSV",
    "EMAIL_UNSUBSCRIBE_SENDER",
  ],
  description:
    "Single fat action for write operations across LifeOps surfaces. " +
    "Subactions: " +
    "gmail_reply (send a Gmail thread reply), " +
    "gmail_manage (archive/star/trash/spam Gmail messages), " +
    "mark_read (mark an inbox entry as read), " +
    "calendar_create (create a Google Calendar event), " +
    "calendar_update (update a Google Calendar event), " +
    "calendar_delete (delete a Google Calendar event), " +
    "reminder_snooze (snooze a LifeOps occurrence), " +
    "reminder_complete (complete a LifeOpsoccurrence), " +
    "reminder_create (create a LifeOps reminder), " +
    "payment_source_add (add a payment source), " +
    "payment_source_delete (delete a payment source), " +
    "payment_csv_import (import bank/CSV transactions), " +
    "unsubscribe_sender (unsubscribe from a Gmail sender). " +
    "Each subaction expects subaction-specific params (see schema). Admin / private access only.",
  descriptionCompressed:
    "LifeOps writes: gmail reply/manage, calendar create/update/delete, reminder snooze/complete/create, payment source add/delete + csv import, mark inbox read, unsubscribe sender.",
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime, message: Memory) =>
    hasLifeOpsAccess(runtime, message),

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
  ): Promise<ActionResult> => {
    const merged = mergeParams(message, options);
    const params = (await extractActionParamsViaLlm<MutateActionParams>({
      runtime,
      message,
      state,
      actionName: ACTION_NAME,
      actionDescription: lifeOpsMutateAction.description ?? "",
      paramSchema: lifeOpsMutateAction.parameters ?? [],
      existingParams: merged,
      requiredFields: ["subaction"],
    })) as MutateActionParams;
    const subaction = normalizeSubaction(params.subaction);
    if (!subaction) {
      return {
        success: false,
        text: `[${ACTION_NAME}] missing subaction; choose one of ${VALID_SUBACTIONS.join(" | ")}.`,
        data: {
          actionName: ACTION_NAME,
          error: "MISSING_SUBACTION",
          validSubactions: VALID_SUBACTIONS,
        },
      };
    }

    const service = new LifeOpsService(runtime);
    try {
      switch (subaction) {
        case "gmail_reply":
          return await dispatchGmailReply(service, params);
        case "gmail_manage":
          return await dispatchGmailManage(service, params);
        case "mark_read":
          return dispatchMarkRead();
        case "calendar_create":
          return await dispatchCalendarCreate(service, params);
        case "calendar_update":
          return await dispatchCalendarUpdate(service, params);
        case "calendar_delete":
          return await dispatchCalendarDelete(service, params);
        case "reminder_snooze":
          return await dispatchReminderSnooze(service, params);
        case "reminder_complete":
          return await dispatchReminderComplete(service, params);
        case "reminder_create":
          return dispatchReminderCreate();
        case "payment_source_add":
          return await dispatchPaymentSourceAdd(service, params);
        case "payment_source_delete":
          return await dispatchPaymentSourceDelete(service, params);
        case "payment_csv_import":
          return await dispatchPaymentCsvImport(service, params);
        case "unsubscribe_sender":
          return await dispatchUnsubscribeSender(service, params);
      }
    } catch (error) {
      if (error instanceof LifeOpsServiceError) {
        return {
          success: false,
          text: error.message,
          data: { actionName: ACTION_NAME, subaction, status: error.status },
        };
      }
      throw error;
    }
  },

  parameters: [
    {
      name: "subaction",
      description:
        "Which write operation. One of: gmail_reply, gmail_manage, mark_read, calendar_create, calendar_update, calendar_delete, reminder_snooze, reminder_complete, reminder_create, payment_source_add, payment_source_delete, payment_csv_import, unsubscribe_sender.",
      required: true,
      schema: { type: "string" as const, enum: [...VALID_SUBACTIONS] },
    },
    {
      name: "messageId",
      description: "gmail_reply only — Gmail message ID to reply to.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "bodyText",
      description: "gmail_reply only — reply body text.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "to",
      description: "gmail_reply only — override To recipients.",
      required: false,
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "cc",
      description: "gmail_reply only — Cc recipients.",
      required: false,
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "subject",
      description: "gmail_reply only — override subject.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "confirmSend",
      description:
        "gmail_reply only — set true to bypass the confirmation gate. Defaults true (the agent action layer assumes the planner confirmed).",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "operation",
      description:
        "gmail_manage only — archive | trash | delete | report_spam | mark_read | mark_unread | apply_label | remove_label.",
      required: false,
      schema: {
        type: "string" as const,
        enum: [
          "archive",
          "trash",
          "delete",
          "report_spam",
          "mark_read",
          "mark_unread",
          "apply_label",
          "remove_label",
        ],
      },
    },
    {
      name: "messageIds",
      description: "gmail_manage only — explicit Gmail message IDs.",
      required: false,
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "query",
      description:
        "gmail_manage only — Gmail search query if messageIds is not provided.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "maxResults",
      description: "gmail_manage only — max messages to apply when using query.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "labelIds",
      description: "gmail_manage only — label IDs for label add/remove ops.",
      required: false,
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "confirmDestructive",
      description:
        "gmail_manage only — required true for trash/delete/report_spam.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "eventId",
      description: "calendar_update / calendar_delete — Google Calendar event ID.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "calendarId",
      description: "calendar_* only — Google Calendar ID. Defaults to primary.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "title",
      description: "calendar_create / calendar_update — event title.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "description",
      description: "calendar_create / calendar_update — event description.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "location",
      description: "calendar_create / calendar_update — event location.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "startAt",
      description: "calendar_create / calendar_update — start ISO datetime.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "endAt",
      description: "calendar_create / calendar_update — end ISO datetime.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "timeZone",
      description: "calendar_create / calendar_update — IANA time zone.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "attendees",
      description:
        "calendar_create / calendar_update — list of {email, displayName} attendees.",
      required: false,
      schema: { type: "array" as const, items: { type: "object" as const } },
    },
    {
      name: "occurrenceId",
      description: "reminder_snooze / reminder_complete — LifeOps occurrence ID.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "minutes",
      description: "reminder_snooze — explicit snooze duration in minutes.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "preset",
      description:
        "reminder_snooze — snooze preset: 15m | 30m | 1h | tonight | tomorrow_morning.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["15m", "30m", "1h", "tonight", "tomorrow_morning"],
      },
    },
    {
      name: "note",
      description: "reminder_complete — optional completion note.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "kind",
      description: "payment_source_add — csv | plaid | manual | paypal.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "label",
      description: "payment_source_add — human-readable label.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "institution",
      description: "payment_source_add — issuing bank or institution.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "accountMask",
      description: "payment_source_add — last-four account mask.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "sourceId",
      description:
        "payment_source_delete / payment_csv_import — payment source ID.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "csvText",
      description: "payment_csv_import — raw CSV body to import.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "dateColumn",
      description: "payment_csv_import — header name for the date column.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "amountColumn",
      description: "payment_csv_import — header name for the amount column.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "merchantColumn",
      description: "payment_csv_import — header name for the merchant column.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "descriptionColumn",
      description:
        "payment_csv_import — header name for the description column.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "categoryColumn",
      description: "payment_csv_import — header name for the category column.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "senderEmail",
      description: "unsubscribe_sender — sender email address to unsubscribe.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "listId",
      description: "unsubscribe_sender — optional List-ID hint.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "blockAfter",
      description:
        "unsubscribe_sender — install a Gmail filter to block future mail. Defaults true.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "trashExisting",
      description:
        "unsubscribe_sender — also trash existing messages from this sender. Defaults false.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "confirmed",
      description:
        "unsubscribe_sender — confirmation flag required by the service. Defaults true (planner is the gate).",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "side",
      description: "owner | agent. Defaults to owner where applicable.",
      required: false,
      schema: { type: "string" as const, enum: ["owner", "agent"] },
    },
    {
      name: "mode",
      description:
        "Connector mode: local | cloud_managed | remote. Defaults vary.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["local", "cloud_managed", "remote"],
      },
    },
    {
      name: "grantId",
      description: "Optional explicit grant ID to target a specific account.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "inboxEntryId",
      description:
        "mark_read only — LifeOps inbox entry ID. (Not yet implemented.)",
      required: false,
      schema: { type: "string" as const },
    },
  ],

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Reply to that finance email saying 'received, thanks'." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll send the reply on the latest finance thread.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Snooze that follow-up reminder for an hour." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll snooze the active occurrence for 60 minutes.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Add a Chase Sapphire payment source labeled 'Sapphire 4242'." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll add a manual payment source with that label.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Unsubscribe me from newsletters@example.com and trash the old messages.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll send the unsubscribe request, install a Gmail filter, and trash existing messages from that sender.",
        },
      },
    ],
  ] as ActionExample[][],
};
