/**
 * LifeOps owner-approval queue: enqueues and resolves the approval requests the
 * assistant raises before taking sensitive actions (sending messages/email,
 * scheduling, bookings). Backed by the shared approval service; this layer owns
 * the LifeOps-specific payloads and list/resolution surface.
 */
import { randomUUID } from "node:crypto";
import { getAgentEventService, resolveApprovalService } from "@elizaos/agent";
import {
  type IAgentRuntime,
  logger,
  ServiceType,
  stableStringify,
} from "@elizaos/core";
import {
  getScheduledTaskRunner,
  type ScheduledTaskInput,
} from "@elizaos/plugin-scheduling";
import {
  type ApprovalAction,
  type ApprovalChannel,
  type ApprovalEnqueueInput,
  ApprovalIdempotencyConflictError,
  type ApprovalListFilter,
  ApprovalNotFoundError,
  type ApprovalPayload,
  type ApprovalQueue,
  type ApprovalRequest,
  type ApprovalRequestState,
  type ApprovalResolution,
  ApprovalStateTransitionError,
  ApprovalTransitionConflictError,
} from "./approval-queue.types.js";
import { getChannelRegistry } from "./channels/index.js";
import { buildApprovalChoiceText } from "./choice-markers.js";
import { readSchedulingApprovalCorrelation } from "./scheduling-approval.js";
import {
  executeRawSql,
  executeRawSqlTx,
  parseJsonRecord,
  sqlInteger,
  sqlJson,
  sqlText,
  type TransactionalDb,
  toText,
} from "./sql.js";

/**
 * Concrete `ApprovalQueue` backed by the `approval_requests` table from
 * `@elizaos/plugin-sql`.
 *
 * Design notes:
 *  - The state-transition table below is the single source of truth for
 *    legal moves. Anything not enumerated throws
 *    `ApprovalStateTransitionError` — there is no fallback, no auto-retry,
 *    no silent normalization (Commandment 8).
 *  - All logging goes through the structured logger only (Commandment 9).
 *  - Each row is scoped to an agent via `agentId`. Cross-agent access is
 *    not supported.
 */

const ALLOWED_TRANSITIONS: Readonly<
  Record<ApprovalRequestState, ReadonlyArray<ApprovalRequestState>>
> = {
  pending: ["approved", "rejected", "expired"],
  approved: ["executing", "rejected", "expired"],
  executing: ["done"],
  done: [],
  rejected: [],
  expired: [],
};

function assertTransition(
  id: string,
  from: ApprovalRequestState,
  to: ApprovalRequestState,
): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new ApprovalStateTransitionError(id, from, to);
  }
}

const VALID_STATES: ReadonlySet<ApprovalRequestState> = new Set([
  "pending",
  "approved",
  "executing",
  "done",
  "rejected",
  "expired",
]);

const VALID_ACTIONS: ReadonlySet<ApprovalAction> = new Set([
  "send_message",
  "send_email",
  "schedule_event",
  "modify_event",
  "cancel_event",
  "book_travel",
  "make_call",
  "sign_document",
  "execute_workflow",
  "spend_money",
]);

const VALID_CHANNELS: ReadonlySet<ApprovalChannel> = new Set([
  "telegram",
  "discord",
  "signal",
  "whatsapp",
  "slack",
  "imessage",
  "sms",
  "x_dm",
  "email",
  "google_calendar",
  "browser",
  "phone",
  "internal",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseState(value: unknown): ApprovalRequestState {
  const text = toText(value);
  if (!VALID_STATES.has(text as ApprovalRequestState)) {
    throw new Error(`[ApprovalQueue] unknown state from db: ${text}`);
  }
  return text as ApprovalRequestState;
}

function parseAction(value: unknown): ApprovalAction {
  const text = toText(value);
  if (!VALID_ACTIONS.has(text as ApprovalAction)) {
    throw new Error(`[ApprovalQueue] unknown action from db: ${text}`);
  }
  return text as ApprovalAction;
}

function parseChannel(value: unknown): ApprovalChannel {
  const text = toText(value);
  if (!VALID_CHANNELS.has(text as ApprovalChannel)) {
    throw new Error(`[ApprovalQueue] unknown channel from db: ${text}`);
  }
  return text as ApprovalChannel;
}

function parseTimestamp(value: unknown): Date {
  if (value instanceof Date) return value;
  const text = toText(value);
  if (!text) {
    throw new Error("[ApprovalQueue] missing timestamp from db");
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`[ApprovalQueue] invalid timestamp from db: ${text}`);
  }
  return date;
}

function parseOptionalTimestamp(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  return parseTimestamp(value);
}

function parseOptionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = toText(value);
  return text === "" ? null : text;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`[ApprovalQueue] invalid ${label}: expected object`);
  }
  return value;
}

function requireStringField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  if (typeof record[field] !== "string") {
    throw new Error(
      `[ApprovalQueue] invalid ${label}.${field}: expected string`,
    );
  }
}

function requireNullableStringField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  const value = record[field];
  if (value !== null && typeof value !== "string") {
    throw new Error(
      `[ApprovalQueue] invalid ${label}.${field}: expected string or null`,
    );
  }
}

function requireOptionalNullableStringField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  if (record[field] === undefined) {
    return;
  }
  requireNullableStringField(record, field, label);
}

function requireStringArrayField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  const value = record[field];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(
      `[ApprovalQueue] invalid ${label}.${field}: expected string[]`,
    );
  }
}

function requireFiniteNumberField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `[ApprovalQueue] invalid ${label}.${field}: expected number`,
    );
  }
}

function requireNullableFiniteNumberField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  const value = record[field];
  if (
    value !== null &&
    (typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new Error(
      `[ApprovalQueue] invalid ${label}.${field}: expected number or null`,
    );
  }
}

function requireOptionalNullableFiniteNumberField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  if (record[field] === undefined) {
    return;
  }
  requireNullableFiniteNumberField(record, field, label);
}

function requireBooleanField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  if (typeof record[field] !== "boolean") {
    throw new Error(
      `[ApprovalQueue] invalid ${label}.${field}: expected boolean`,
    );
  }
}

function requireOptionalBooleanField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  if (record[field] === undefined) return;
  requireBooleanField(record, field, label);
}

function requireOptionalNullableStringArrayField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  const value = record[field];
  if (value === undefined || value === null) return;
  requireStringArrayField(record, field, label);
}

function requireCalendarApprovalAttendees(
  value: unknown,
  label: string,
  nullable: boolean,
): void {
  if (nullable && value === null) return;
  if (!Array.isArray(value)) {
    throw new Error(
      `[ApprovalQueue] invalid ${label}: expected calendar attendee array${nullable ? " or null" : ""}`,
    );
  }
  value.forEach((entry, index) => {
    if (typeof entry === "string") return;
    const attendee = requireRecord(entry, `${label}[${index}]`);
    requireStringField(attendee, "email", `${label}[${index}]`);
    requireOptionalNullableStringField(
      attendee,
      "displayName",
      `${label}[${index}]`,
    );
    requireOptionalBooleanField(attendee, "optional", `${label}[${index}]`);
  });
}

function requireOptionalCalendarSeriesMasterBinding(
  record: Record<string, unknown>,
  label: string,
): void {
  if (record.seriesMaster === undefined || record.seriesMaster === null) return;
  const binding = requireRecord(record.seriesMaster, `${label}.seriesMaster`);
  requireStringField(binding, "externalId", `${label}.seriesMaster`);
  requireFiniteNumberField(binding, "startAtMs", `${label}.seriesMaster`);
  requireStringField(binding, "updatedAt", `${label}.seriesMaster`);
  requireStringField(binding, "etag", `${label}.seriesMaster`);
}

function requireOptionalRecordField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  const value = record[field];
  if (value !== undefined && value !== null && !isRecord(value)) {
    throw new Error(
      `[ApprovalQueue] invalid ${label}.${field}: expected object or null`,
    );
  }
}

function requirePrimitiveRecordField(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  const value = requireRecord(record[field], `${label}.${field}`);
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry !== "string" &&
      typeof entry !== "number" &&
      typeof entry !== "boolean"
    ) {
      throw new Error(
        `[ApprovalQueue] invalid ${label}.${field}.${key}: expected string, number, or boolean`,
      );
    }
  }
}

function requireCalendarMutationSourceBinding(
  record: Record<string, unknown>,
  label: string,
): void {
  requireOptionalNullableStringField(record, "grantId", label);
  requireOptionalNullableStringField(record, "side", label);
  if (
    record.side !== undefined &&
    record.side !== null &&
    record.side !== "owner" &&
    record.side !== "agent"
  ) {
    throw new Error(
      `[ApprovalQueue] invalid ${label}.side: expected owner, agent, or null`,
    );
  }
}

function requireCalendarMutationTargetVersion(
  record: Record<string, unknown>,
  label: string,
): void {
  requireCalendarMutationSourceBinding(record, label);
  requireOptionalNullableStringField(record, "expectedProvider", label);
  requireOptionalNullableStringField(record, "expectedProviderVersion", label);
  requireOptionalNullableStringField(record, "expectedEventUpdatedAt", label);
  requireOptionalNullableFiniteNumberField(
    record,
    "expectedEventStartAtMs",
    label,
  );
  requireOptionalNullableStringField(record, "recurrenceScope", label);
  requireOptionalCalendarSeriesMasterBinding(record, label);
  if (
    record.expectedProvider !== undefined &&
    record.expectedProvider !== null &&
    !["google", "microsoft", "apple_calendar", "ics"].includes(
      String(record.expectedProvider),
    )
  ) {
    throw new Error(
      `[ApprovalQueue] invalid ${label}.expectedProvider: unsupported provider`,
    );
  }
  if (
    record.recurrenceScope !== undefined &&
    record.recurrenceScope !== null &&
    record.recurrenceScope !== "instance" &&
    record.recurrenceScope !== "series"
  ) {
    throw new Error(
      `[ApprovalQueue] invalid ${label}.recurrenceScope: expected instance, series, or null`,
    );
  }
}

function requireTravelPassengers(
  record: Record<string, unknown>,
  label: string,
): void {
  const passengers = record.passengers;
  if (passengers === undefined) {
    return;
  }
  if (!Array.isArray(passengers)) {
    throw new Error(
      `[ApprovalQueue] invalid ${label}.passengers: expected array`,
    );
  }
  passengers.forEach((passenger, index) => {
    const passengerRecord = requireRecord(
      passenger,
      `${label}.passengers[${index}]`,
    );
    requireStringField(
      passengerRecord,
      "givenName",
      `${label}.passengers[${index}]`,
    );
    requireStringField(
      passengerRecord,
      "familyName",
      `${label}.passengers[${index}]`,
    );
    requireStringField(
      passengerRecord,
      "bornOn",
      `${label}.passengers[${index}]`,
    );
    for (const field of [
      "offerPassengerId",
      "email",
      "phoneNumber",
      "title",
      "gender",
    ]) {
      requireOptionalNullableStringField(
        passengerRecord,
        field,
        `${label}.passengers[${index}]`,
      );
    }
  });
}

function requireTravelCalendarSync(
  record: Record<string, unknown>,
  label: string,
): void {
  const value = record.calendarSync;
  if (value === undefined || value === null) {
    return;
  }
  const calendarSync = requireRecord(value, `${label}.calendarSync`);
  requireBooleanField(calendarSync, "enabled", `${label}.calendarSync`);
  for (const field of [
    "calendarId",
    "title",
    "description",
    "location",
    "timeZone",
  ]) {
    requireOptionalNullableStringField(
      calendarSync,
      field,
      `${label}.calendarSync`,
    );
  }
}

function requireTravelCost(
  record: Record<string, unknown>,
  label: string,
): void {
  const value = record.cost;
  if (value === undefined || value === null) {
    return;
  }
  const cost = requireRecord(value, `${label}.cost`);
  requireFiniteNumberField(cost, "totalUsd", `${label}.cost`);
  requireFiniteNumberField(cost, "creatorMarkupUsd", `${label}.cost`);
  requireFiniteNumberField(cost, "platformFeeUsd", `${label}.cost`);
  requireNullableFiniteNumberField(cost, "markupPercent", `${label}.cost`);
}

function requirePaymentRequired(
  record: Record<string, unknown>,
  label: string,
): void {
  const value = record.paymentRequired;
  if (value === undefined || value === null) {
    return;
  }
  const payment = requireRecord(value, `${label}.paymentRequired`);
  for (const field of ["amount", "asset", "network", "payTo", "scheme"]) {
    requireStringField(payment, field, `${label}.paymentRequired`);
  }
  requireNullableStringField(payment, "expiresAt", `${label}.paymentRequired`);
  requireNullableStringField(
    payment,
    "description",
    `${label}.paymentRequired`,
  );
}

function assertApprovalPayload(
  record: Record<string, unknown>,
  action: ApprovalAction,
  label: string,
): asserts record is ApprovalPayload {
  switch (action) {
    case "send_message":
      requireStringField(record, "recipient", label);
      requireStringField(record, "body", label);
      requireNullableStringField(record, "replyToMessageId", label);
      if (record.scheduling !== undefined) {
        readSchedulingApprovalCorrelation(
          record as ApprovalPayload,
          `${label}.scheduling`,
        );
      }
      break;
    case "send_email":
      requireStringArrayField(record, "to", label);
      requireStringArrayField(record, "cc", label);
      requireStringArrayField(record, "bcc", label);
      requireStringField(record, "subject", label);
      requireStringField(record, "body", label);
      requireNullableStringField(record, "threadId", label);
      requireOptionalNullableStringField(record, "replyToMessageId", label);
      if (record.scheduling !== undefined) {
        readSchedulingApprovalCorrelation(
          record as ApprovalPayload,
          `${label}.scheduling`,
        );
      }
      break;
    case "schedule_event":
      requireStringField(record, "calendarId", label);
      requireStringField(record, "title", label);
      requireFiniteNumberField(record, "startsAtMs", label);
      requireFiniteNumberField(record, "endsAtMs", label);
      requireCalendarApprovalAttendees(
        record.attendees,
        `${label}.attendees`,
        false,
      );
      requireNullableStringField(record, "location", label);
      requireNullableStringField(record, "description", label);
      requireOptionalNullableStringField(record, "timeZone", label);
      requireOptionalNullableFiniteNumberField(
        record,
        "durationMinutes",
        label,
      );
      requireOptionalNullableStringField(record, "windowPreset", label);
      if (
        record.windowPreset !== undefined &&
        record.windowPreset !== null &&
        record.windowPreset !== "tomorrow_morning" &&
        record.windowPreset !== "tomorrow_afternoon" &&
        record.windowPreset !== "tomorrow_evening"
      ) {
        throw new Error(
          `[ApprovalQueue] invalid ${label}.windowPreset: unsupported preset`,
        );
      }
      requireOptionalNullableStringArrayField(record, "recurrence", label);
      requireOptionalBooleanField(record, "notifyAttendees", label);
      if (record.editorRequestSha256 !== undefined) {
        requireStringField(record, "editorRequestSha256", label);
      }
      if (record.travelBuffer !== undefined && record.travelBuffer !== null) {
        const travelBuffer = requireRecord(
          record.travelBuffer,
          `${label}.travelBuffer`,
        );
        requireFiniteNumberField(
          travelBuffer,
          "bufferMinutes",
          `${label}.travelBuffer`,
        );
        requireStringField(travelBuffer, "method", `${label}.travelBuffer`);
        requireNullableStringField(
          travelBuffer,
          "originAddress",
          `${label}.travelBuffer`,
        );
        requireNullableStringField(
          travelBuffer,
          "destinationAddress",
          `${label}.travelBuffer`,
        );
      }
      requireCalendarMutationSourceBinding(record, label);
      break;
    case "modify_event": {
      requireStringField(record, "calendarId", label);
      requireStringField(record, "eventId", label);
      requireCalendarMutationTargetVersion(record, label);
      const patch = requireRecord(record.patch, `${label}.patch`);
      requireNullableStringField(patch, "title", `${label}.patch`);
      requireNullableFiniteNumberField(patch, "startsAtMs", `${label}.patch`);
      requireNullableFiniteNumberField(patch, "endsAtMs", `${label}.patch`);
      requireCalendarApprovalAttendees(
        patch.attendees,
        `${label}.patch.attendees`,
        true,
      );
      requireNullableStringField(patch, "location", `${label}.patch`);
      requireNullableStringField(patch, "description", `${label}.patch`);
      requireOptionalNullableStringField(patch, "timeZone", `${label}.patch`);
      requireOptionalNullableStringArrayField(
        patch,
        "recurrence",
        `${label}.patch`,
      );
      requireOptionalBooleanField(record, "notifyAttendees", label);
      if (record.editorRequestSha256 !== undefined) {
        requireStringField(record, "editorRequestSha256", label);
      }
      break;
    }
    case "cancel_event":
      requireStringField(record, "calendarId", label);
      requireStringField(record, "eventId", label);
      requireBooleanField(record, "notifyAttendees", label);
      requireCalendarMutationTargetVersion(record, label);
      requireOptionalNullableStringField(record, "cancellationMode", label);
      if (record.editorRequestSha256 !== undefined) {
        requireStringField(record, "editorRequestSha256", label);
      }
      if (
        record.cancellationMode !== undefined &&
        record.cancellationMode !== null &&
        record.cancellationMode !== "organizer_cancel" &&
        record.cancellationMode !== "decline_invitation" &&
        record.cancellationMode !== "remove_private_copy"
      ) {
        throw new Error(
          `[ApprovalQueue] invalid ${label}.cancellationMode: unsupported cancellation mode`,
        );
      }
      break;
    case "book_travel":
      if (
        record.kind !== "flight" &&
        record.kind !== "hotel" &&
        record.kind !== "ground"
      ) {
        throw new Error(`[ApprovalQueue] invalid ${label}.kind`);
      }
      requireStringField(record, "provider", label);
      requireStringField(record, "itineraryRef", label);
      requireFiniteNumberField(record, "totalCents", label);
      requireStringField(record, "currency", label);
      requireOptionalNullableStringField(record, "offerId", label);
      requireOptionalNullableStringField(record, "offerRequestId", label);
      if (
        record.orderType !== undefined &&
        record.orderType !== null &&
        record.orderType !== "hold" &&
        record.orderType !== "instant"
      ) {
        throw new Error(`[ApprovalQueue] invalid ${label}.orderType`);
      }
      requireOptionalRecordField(record, "search", label);
      requireTravelPassengers(record, label);
      requireTravelCalendarSync(record, label);
      requireOptionalNullableStringField(record, "summary", label);
      requireTravelCost(record, label);
      requirePaymentRequired(record, label);
      break;
    case "make_call":
      requireStringField(record, "to", label);
      requireStringField(record, "script", label);
      requireFiniteNumberField(record, "maxDurationSeconds", label);
      break;
    case "sign_document":
      requireStringField(record, "documentId", label);
      requireStringField(record, "documentName", label);
      requireStringField(record, "signatureUrl", label);
      requireStringField(record, "deadline", label);
      break;
    case "execute_workflow":
      requireStringField(record, "workflowId", label);
      requirePrimitiveRecordField(record, "input", label);
      break;
    case "spend_money":
      requireStringField(record, "vendor", label);
      requireFiniteNumberField(record, "amountCents", label);
      requireStringField(record, "currency", label);
      requireStringField(record, "memo", label);
      break;
  }
}

function validateApprovalPayload(
  value: unknown,
  label: string,
): ApprovalPayload {
  const record = requireRecord(value, label);
  const action = parseAction(record.action);
  assertApprovalPayload(record, action, label);
  return record;
}

function rowToRequest(row: Record<string, unknown>): ApprovalRequest {
  const action = parseAction(row.action);
  const payload = validateApprovalPayload(
    parseJsonRecord(row.payload),
    `row ${toText(row.id)} payload`,
  );
  if (payload.action !== action) {
    throw new Error(
      `[ApprovalQueue] row ${toText(row.id)} payload action ${payload.action} does not match request action ${action}`,
    );
  }
  return {
    id: toText(row.id),
    createdAt: parseTimestamp(row.created_at),
    updatedAt: parseTimestamp(row.updated_at),
    state: parseState(row.state),
    requestedBy: toText(row.requested_by),
    subjectUserId: toText(row.subject_user_id),
    action,
    payload,
    channel: parseChannel(row.channel),
    reason: toText(row.reason),
    idempotencyKey: parseOptionalText(row.idempotency_key),
    expiresAt: parseTimestamp(row.expires_at),
    resolvedAt: parseOptionalTimestamp(row.resolved_at),
    resolvedBy: parseOptionalText(row.resolved_by),
    resolutionReason: parseOptionalText(row.resolution_reason),
  };
}

const SELECT_COLUMNS =
  "id, state, requested_by, subject_user_id, action, payload, channel, reason, idempotency_key, expires_at, resolved_at, resolved_by, resolution_reason, created_at, updated_at";

function sameIdempotentApproval(
  existing: ApprovalRequest,
  input: ApprovalEnqueueInput,
  payload: ApprovalPayload,
): boolean {
  return (
    existing.requestedBy === input.requestedBy &&
    existing.subjectUserId === input.subjectUserId &&
    existing.action === input.action &&
    existing.channel === input.channel &&
    existing.reason === input.reason &&
    existing.expiresAt.getTime() === input.expiresAt.getTime() &&
    stableStringify(existing.payload) === stableStringify(payload)
  );
}

function timestampLiteral(date: Date): string {
  return sqlText(date.toISOString());
}

interface AssistantEventEmitter {
  emit?: (event: {
    runId: string;
    stream: string;
    data: Record<string, unknown>;
    agentId?: string;
  }) => void;
}

function emitApprovalChoiceEvent(
  runtime: IAgentRuntime,
  input: { requestId: string; reason: string; action: ApprovalAction },
): void {
  const eventService = getAgentEventService(
    runtime,
  ) as AssistantEventEmitter | null;
  if (!eventService?.emit) return;
  eventService.emit({
    runId: randomUUID(),
    stream: "assistant",
    agentId: String(runtime.agentId),
    data: {
      text: buildApprovalChoiceText(input),
      source: "lifeops-approval",
      requestId: input.requestId,
      action: input.action,
    },
  });
}

interface NotificationEmitter {
  notify: (input: {
    title: string;
    body?: string;
    category?: string;
    priority?: string;
    source?: string;
    deepLink?: string;
    groupKey?: string;
    data?: Record<string, unknown>;
  }) => Promise<unknown>;
}

function getNotifier(runtime: IAgentRuntime): NotificationEmitter | null {
  const svc = runtime.getService(
    ServiceType.NOTIFICATION,
  ) as NotificationEmitter | null;
  return svc && typeof svc.notify === "function" ? svc : null;
}

const APPROVAL_ESCALATION_CHANNEL_ORDER = [
  "telegram",
  "signal",
  "whatsapp",
  "discord",
  "sms",
  "voice",
  "imessage",
  "email",
  "x_dm",
  "push",
  "in_app",
] as const;

function approvalEscalationSteps(
  runtime: IAgentRuntime,
  preferredChannel: ApprovalChannel,
): NonNullable<ScheduledTaskInput["escalation"]>["steps"] {
  const registry = getChannelRegistry(runtime);
  const registered = new Set(registry?.list().map((c) => c.kind) ?? []);
  const ordered = [preferredChannel, ...APPROVAL_ESCALATION_CHANNEL_ORDER];
  const seen = new Set<string>();
  return ordered
    .filter((channelKey) => {
      if (seen.has(channelKey) || !registered.has(channelKey)) return false;
      seen.add(channelKey);
      const channel = registry?.get(channelKey);
      return (
        channelKey === "push" ||
        channelKey === "in_app" ||
        Boolean(channel?.send)
      );
    })
    .map((channelKey, index) => ({
      channelKey,
      delayMinutes: index === 0 ? 0 : 15,
      intensity: index === 0 ? "normal" : "urgent",
    }));
}

async function scheduleApprovalTask(
  runtime: IAgentRuntime,
  input: {
    agentId: string;
    requestId: string;
    subjectUserId: string;
    action: ApprovalAction;
    channel: ApprovalChannel;
    reason: string;
    requestedBy: string;
    createdAt: Date;
  },
): Promise<string> {
  const runner = getScheduledTaskRunner(runtime, { agentId: input.agentId });
  const task = await runner.schedule({
    kind: "approval",
    promptInstructions: `Approval needed: ${input.reason}. Reply "approve ${input.requestId}" or "reject ${input.requestId}".`,
    trigger: { kind: "once", atIso: input.createdAt.toISOString() },
    priority: "high",
    completionCheck: {
      kind: "user_acknowledged",
      params: { requestId: input.requestId },
    },
    escalation: {
      steps: approvalEscalationSteps(runtime, input.channel),
    },
    subject: { kind: "self", id: input.subjectUserId },
    idempotencyKey: `approval:${input.requestId}`,
    respectsGlobalPause: false,
    source: "plugin",
    createdBy: input.agentId,
    ownerVisible: true,
    metadata: {
      approvalRequestId: input.requestId,
      approvalAction: input.action,
      approvalChannel: input.channel,
      requestedBy: input.requestedBy,
      pendingPromptRoomId: `approval:${input.requestId}`,
      pendingPromptAction: input.action,
    },
  });
  logger.info(
    `[ApprovalQueue] scheduled approval task ${task.taskId} for ${input.requestId}`,
  );
  return task.taskId;
}

export interface ApprovalQueueOptions {
  readonly agentId: string;
}

export interface TransactionalApprovalEnqueueResult {
  readonly request: ApprovalRequest;
  readonly reused: boolean;
}

export class PgApprovalQueue implements ApprovalQueue {
  private readonly runtime: IAgentRuntime;
  private readonly agentId: string;

  constructor(runtime: IAgentRuntime, options: ApprovalQueueOptions) {
    this.runtime = runtime;
    this.agentId = options.agentId;
  }

  async enqueue(input: ApprovalEnqueueInput): Promise<ApprovalRequest> {
    const inserted = await this.insertApproval(input);
    if (inserted.reused) {
      return inserted.request;
    }
    try {
      await this.surfaceEnqueuedApproval(inserted.request);
    } catch (error) {
      // error-policy:J2 The approval row and ScheduledTask must be atomic from
      // the caller's perspective on the legacy enqueue path. Transactional
      // scheduling callers commit the approval with their domain mutation and
      // report a failed side-channel separately instead of deleting either.
      await executeRawSql(
        this.runtime,
        `DELETE FROM approval_requests WHERE id = ${sqlText(inserted.request.id)} AND agent_id = ${sqlText(this.agentId)}`,
      );
      throw new Error(
        `[ApprovalQueue] failed to schedule approval task for ${inserted.request.id}; rolled back approval row`,
        { cause: error },
      );
    }
    return inserted.request;
  }

  async enqueueConfirmed(
    input: ApprovalEnqueueInput,
    resolution: ApprovalResolution,
  ): Promise<ApprovalRequest> {
    const inserted = await this.insertApproval(input, undefined, resolution);
    if (inserted.request.state === "pending") {
      try {
        return await this.approve(inserted.request.id, resolution);
      } catch (error) {
        if (!(error instanceof ApprovalTransitionConflictError)) throw error;
        const current = await this.byId(inserted.request.id);
        if (!current) throw new ApprovalNotFoundError(inserted.request.id);
        if (
          current.state === "approved" ||
          current.state === "executing" ||
          current.state === "done"
        ) {
          return current;
        }
        throw error;
      }
    }
    return inserted.request;
  }

  /**
   * Insert or reuse an approval inside the caller's database transaction.
   * This is the same `approval_requests` queue, not an auxiliary queue; it lets
   * a domain mutation and its owner gate commit or roll back together.
   * User-facing task/notification side-channels run only after commit via
   * {@link surfaceEnqueuedApproval}.
   */
  async enqueueTransactional(
    input: ApprovalEnqueueInput,
    tx: TransactionalDb,
  ): Promise<TransactionalApprovalEnqueueResult> {
    return this.insertApproval(input, tx);
  }

  async surfaceEnqueuedApproval(request: ApprovalRequest): Promise<void> {
    await scheduleApprovalTask(this.runtime, {
      agentId: this.agentId,
      requestId: request.id,
      subjectUserId: request.subjectUserId,
      action: request.action,
      channel: request.channel,
      reason: request.reason,
      requestedBy: request.requestedBy,
      createdAt: request.createdAt,
    });
    try {
      emitApprovalChoiceEvent(this.runtime, {
        requestId: request.id,
        reason: request.reason,
        action: request.action,
      });
    } catch (err) {
      // error-policy:J7 chat choice emission is a non-blocking side-channel,
      // but reportError keeps stranded approval prompts observable.
      this.runtime.reportError("ApprovalQueue.chatChoice", err, {
        requestId: request.id,
        action: request.action,
      });
    }
    void getNotifier(this.runtime)
      ?.notify({
        title: "Approval needed",
        body: request.reason.slice(0, 200),
        category: "approval",
        priority: "high",
        source: "lifeops",
        deepLink: "/chat",
        groupKey: `approval:${request.id}`,
        data: { requestId: request.id, kind: request.action },
      })
      // error-policy:J7 notify is a side-channel that must not block the
      // enqueue, but a swallowed failure means the owner is never told an
      // approval is pending — surface it so repeated notify-rail failures are
      // observable instead of silently stranding approvals.
      .catch((err) => {
        this.runtime.reportError("ApprovalQueue.notify", err, {
          requestId: request.id,
          action: request.action,
        });
      });
  }

  private async insertApproval(
    input: ApprovalEnqueueInput,
    tx?: TransactionalDb,
    confirmedResolution?: ApprovalResolution,
  ): Promise<TransactionalApprovalEnqueueResult> {
    const payload = validateApprovalPayload(input.payload, "enqueue payload");
    if (input.action !== payload.action) {
      throw new Error(
        `[ApprovalQueue] payload action ${payload.action} does not match request action ${input.action}`,
      );
    }
    const id = randomUUID();
    const now = new Date();
    const idempotencyKey = input.idempotencyKey?.trim() || null;
    const initialState = confirmedResolution ? "approved" : "pending";
    const sql = `INSERT INTO approval_requests (
        id, state, requested_by, subject_user_id, action, payload, channel, reason,
        idempotency_key, expires_at, resolved_at, resolved_by, resolution_reason,
        agent_id, created_at, updated_at
      ) VALUES (
        ${sqlText(id)},
        ${sqlText(initialState)},
        ${sqlText(input.requestedBy)},
        ${sqlText(input.subjectUserId)},
        ${sqlText(input.action)},
        ${sqlJson(payload)},
        ${sqlText(input.channel)},
        ${sqlText(input.reason)},
        ${sqlText(idempotencyKey)},
        ${timestampLiteral(input.expiresAt)},
        ${confirmedResolution ? timestampLiteral(now) : "NULL"},
        ${confirmedResolution ? sqlText(confirmedResolution.resolvedBy) : "NULL"},
        ${confirmedResolution ? sqlText(confirmedResolution.resolutionReason) : "NULL"},
        ${sqlText(this.agentId)},
        ${timestampLiteral(now)},
        ${timestampLiteral(now)}
      )
      ${
        idempotencyKey
          ? "ON CONFLICT (agent_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING"
          : ""
      }
      RETURNING ${SELECT_COLUMNS}`;
    const rows = tx
      ? await executeRawSqlTx(tx, sql)
      : await executeRawSql(this.runtime, sql);
    if (rows.length === 0) {
      if (!idempotencyKey) {
        throw new Error("[ApprovalQueue] enqueue returned no rows");
      }
      const existing = await this.fetchByIdempotencyKey(idempotencyKey, tx);
      if (!existing) {
        throw new Error(
          "[ApprovalQueue] idempotent enqueue conflict returned no existing row",
        );
      }
      if (!sameIdempotentApproval(existing, input, payload)) {
        throw new ApprovalIdempotencyConflictError(idempotencyKey);
      }
      return { request: existing, reused: true };
    }
    logger.info(
      `[ApprovalQueue] enqueued ${input.action} for ${input.subjectUserId} as ${id}`,
    );
    return { request: rowToRequest(rows[0]), reused: false };
  }

  async list(
    filter: ApprovalListFilter,
  ): Promise<ReadonlyArray<ApprovalRequest>> {
    const where: string[] = [`agent_id = ${sqlText(this.agentId)}`];
    if (filter.subjectUserId !== null) {
      where.push(`subject_user_id = ${sqlText(filter.subjectUserId)}`);
    }
    if (filter.state !== null) {
      where.push(`state = ${sqlText(filter.state)}`);
    }
    if (filter.action !== null) {
      where.push(`action = ${sqlText(filter.action)}`);
    }
    const sql = `SELECT ${SELECT_COLUMNS} FROM approval_requests
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ${sqlInteger(filter.limit)}`;
    const rows = await executeRawSql(this.runtime, sql);
    return rows.map(rowToRequest);
  }

  async byId(id: string): Promise<ApprovalRequest | null> {
    const rows = await this.fetchById(id);
    return rows ?? null;
  }

  async byIdempotencyKey(
    idempotencyKey: string,
  ): Promise<ApprovalRequest | null> {
    const normalized = idempotencyKey.trim();
    if (!normalized) {
      throw new Error("[ApprovalQueue] idempotency key is required");
    }
    return this.fetchByIdempotencyKey(normalized);
  }

  async approve(
    id: string,
    resolution: ApprovalResolution,
  ): Promise<ApprovalRequest> {
    return this.transitionWithResolution(id, "approved", resolution);
  }

  async reject(
    id: string,
    resolution: ApprovalResolution,
  ): Promise<ApprovalRequest> {
    return this.transitionWithResolution(id, "rejected", resolution);
  }

  async markExecuting(id: string): Promise<ApprovalRequest> {
    return this.transitionWithoutResolution(id, "executing");
  }

  async markDone(id: string): Promise<ApprovalRequest> {
    return this.transitionWithoutResolution(id, "done");
  }

  async markExpired(id: string): Promise<ApprovalRequest> {
    return this.transitionWithoutResolution(id, "expired");
  }

  async purgeExpired(now: Date): Promise<ReadonlyArray<string>> {
    const sql = `UPDATE approval_requests
      SET state = ${sqlText("expired")}, updated_at = ${timestampLiteral(now)}
      WHERE agent_id = ${sqlText(this.agentId)}
        AND state = ${sqlText("pending")}
        AND expires_at <= ${timestampLiteral(now)}
      RETURNING id`;
    const rows = await executeRawSql(this.runtime, sql);
    const ids = rows.map((row) => toText(row.id));
    if (ids.length > 0) {
      logger.info(`[ApprovalQueue] purged ${ids.length} expired requests`);
    }
    return ids;
  }

  // Protected so tests can subclass and interleave work between the read and
  // the compare-and-swap write (deterministic TOCTOU coverage).
  protected async fetchById(id: string): Promise<ApprovalRequest | null> {
    const sql = `SELECT ${SELECT_COLUMNS} FROM approval_requests
      WHERE id = ${sqlText(id)} AND agent_id = ${sqlText(this.agentId)}
      LIMIT 1`;
    const rows = await executeRawSql(this.runtime, sql);
    if (rows.length === 0) return null;
    return rowToRequest(rows[0]);
  }

  private async fetchByIdempotencyKey(
    idempotencyKey: string,
    tx?: TransactionalDb,
  ): Promise<ApprovalRequest | null> {
    const sql = `SELECT ${SELECT_COLUMNS} FROM approval_requests
      WHERE idempotency_key = ${sqlText(idempotencyKey)}
        AND agent_id = ${sqlText(this.agentId)}
      LIMIT 1`;
    const rows = tx
      ? await executeRawSqlTx(tx, sql)
      : await executeRawSql(this.runtime, sql);
    if (rows.length === 0) return null;
    return rowToRequest(rows[0]);
  }

  /**
   * The UPDATE affected no row even though the transition looked legal at
   * read time: either the row vanished, or a concurrent writer moved it to a
   * different state between our read and our compare-and-swap write (e.g.
   * `purgeExpired` racing an in-flight `approve`). Re-read once to classify
   * and surface the loss as a typed conflict — never retry the write.
   */
  private async raiseLostRace(
    id: string,
    target: ApprovalRequestState,
  ): Promise<never> {
    const actual = await this.fetchById(id);
    if (!actual) throw new ApprovalNotFoundError(id);
    logger.warn(
      `[ApprovalQueue] transition conflict: request ${id} moved to ${actual.state} mid-flight, refusing ${actual.state} -> ${target}`,
    );
    throw new ApprovalTransitionConflictError(id, actual.state, target);
  }

  /**
   * Lazily enforce expiry at the transition boundary (#11092): no production
   * caller runs purgeExpired periodically, so without this check a request
   * whose expiresAt has passed stays `pending` forever and remains approvable.
   * A lapsed pending row is flipped to `expired` (CAS — a concurrent
   * transition wins cleanly) and the attempted transition is refused as
   * from-expired, the same typed error callers already handle.
   */
  private async refuseLapsedPending(
    current: ApprovalRequest,
    target: ApprovalRequestState,
  ): Promise<void> {
    if (current.state !== "pending" || target === "expired") return;
    if (current.expiresAt.getTime() > Date.now()) return;
    await this.transitionWithoutResolution(current.id, "expired");
    throw new ApprovalStateTransitionError(current.id, "expired", target);
  }

  private async transitionWithResolution(
    id: string,
    target: ApprovalRequestState,
    resolution: ApprovalResolution,
  ): Promise<ApprovalRequest> {
    const current = await this.fetchById(id);
    if (!current) throw new ApprovalNotFoundError(id);
    await this.refuseLapsedPending(current, target);
    assertTransition(id, current.state, target);
    const now = new Date();
    // Compare-and-swap: the state guard makes the read-assert-write race-safe.
    // A concurrent transition (e.g. purgeExpired) makes this UPDATE match no
    // row instead of silently resurrecting a terminal state.
    const sql = `UPDATE approval_requests
      SET state = ${sqlText(target)},
          resolved_at = ${timestampLiteral(now)},
          resolved_by = ${sqlText(resolution.resolvedBy)},
          resolution_reason = ${sqlText(resolution.resolutionReason)},
          updated_at = ${timestampLiteral(now)}
      WHERE id = ${sqlText(id)} AND agent_id = ${sqlText(this.agentId)}
        AND state = ${sqlText(current.state)}
      RETURNING ${SELECT_COLUMNS}`;
    const rows = await executeRawSql(this.runtime, sql);
    if (rows.length === 0) {
      await this.raiseLostRace(id, target);
    }
    logger.info(
      `[ApprovalQueue] ${current.state} -> ${target} (${id}) by ${resolution.resolvedBy}`,
    );
    return rowToRequest(rows[0]);
  }

  private async transitionWithoutResolution(
    id: string,
    target: ApprovalRequestState,
  ): Promise<ApprovalRequest> {
    const current = await this.fetchById(id);
    if (!current) throw new ApprovalNotFoundError(id);
    await this.refuseLapsedPending(current, target);
    assertTransition(id, current.state, target);
    const now = new Date();
    // Compare-and-swap: see transitionWithResolution.
    const sql = `UPDATE approval_requests
      SET state = ${sqlText(target)},
          updated_at = ${timestampLiteral(now)}
      WHERE id = ${sqlText(id)} AND agent_id = ${sqlText(this.agentId)}
        AND state = ${sqlText(current.state)}
      RETURNING ${SELECT_COLUMNS}`;
    const rows = await executeRawSql(this.runtime, sql);
    if (rows.length === 0) {
      await this.raiseLostRace(id, target);
    }
    logger.info(`[ApprovalQueue] ${current.state} -> ${target} (${id})`);
    return rowToRequest(rows[0]);
  }
}

/**
 * Resolve the approval queue for `options.agentId`.
 *
 * Promoted to the first-class `@elizaos/agent` runtime service `ApprovalService`
 * (serviceType `eliza_approval`) in LifeOps Slice 4. This factory prefers the
 * registered runtime service (first-wins dedup) and falls back to a
 * directly-constructed `PgApprovalQueue` when the service is absent. Both read
 * and write the same public-schema `approval_requests` table via identical raw
 * SQL, so the fallback is behaviorally identical.
 *
 * The runtime service is structurally the same `PgApprovalQueue`; the single
 * narrowing below re-asserts PA's travel/Duffel-precise payload contract over
 * the runtime's structurally-identical (travel-agnostic) queue interface.
 */
export function createApprovalQueue(
  runtime: IAgentRuntime,
  options: ApprovalQueueOptions,
): ApprovalQueue {
  const service = resolveApprovalService(runtime);
  if (service) {
    return service.getQueue(options.agentId) as unknown as ApprovalQueue;
  }
  return new PgApprovalQueue(runtime, options);
}
