import { randomUUID } from "node:crypto";
import { type IAgentRuntime, logger } from "@elizaos/core";
import {
  type ApprovalAction,
  type ApprovalChannel,
  type ApprovalEnqueueInput,
  type ApprovalListFilter,
  ApprovalNotFoundError,
  type ApprovalPayload,
  type ApprovalQueue,
  type ApprovalRequest,
  type ApprovalRequestState,
  type ApprovalResolution,
  ApprovalStateTransitionError,
} from "./approval-queue.types.js";
import {
  executeRawSql,
  parseJsonRecord,
  sqlInteger,
  sqlJson,
  sqlText,
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
  approved: ["executing", "rejected"],
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
      break;
    case "send_email":
      requireStringArrayField(record, "to", label);
      requireStringArrayField(record, "cc", label);
      requireStringArrayField(record, "bcc", label);
      requireStringField(record, "subject", label);
      requireStringField(record, "body", label);
      requireNullableStringField(record, "threadId", label);
      requireOptionalNullableStringField(record, "replyToMessageId", label);
      break;
    case "schedule_event":
      requireStringField(record, "calendarId", label);
      requireStringField(record, "title", label);
      requireFiniteNumberField(record, "startsAtMs", label);
      requireFiniteNumberField(record, "endsAtMs", label);
      requireStringArrayField(record, "attendees", label);
      requireNullableStringField(record, "location", label);
      requireNullableStringField(record, "description", label);
      break;
    case "modify_event": {
      requireStringField(record, "calendarId", label);
      requireStringField(record, "eventId", label);
      const patch = requireRecord(record.patch, `${label}.patch`);
      requireNullableStringField(patch, "title", `${label}.patch`);
      requireNullableFiniteNumberField(patch, "startsAtMs", `${label}.patch`);
      requireNullableFiniteNumberField(patch, "endsAtMs", `${label}.patch`);
      const attendees = patch.attendees;
      if (
        attendees !== null &&
        (!Array.isArray(attendees) ||
          attendees.some((entry) => typeof entry !== "string"))
      ) {
        throw new Error(
          `[ApprovalQueue] invalid ${label}.patch.attendees: expected string[] or null`,
        );
      }
      requireNullableStringField(patch, "location", `${label}.patch`);
      requireNullableStringField(patch, "description", `${label}.patch`);
      break;
    }
    case "cancel_event":
      requireStringField(record, "calendarId", label);
      requireStringField(record, "eventId", label);
      requireBooleanField(record, "notifyAttendees", label);
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
    expiresAt: parseTimestamp(row.expires_at),
    resolvedAt: parseOptionalTimestamp(row.resolved_at),
    resolvedBy: parseOptionalText(row.resolved_by),
    resolutionReason: parseOptionalText(row.resolution_reason),
  };
}

const SELECT_COLUMNS =
  "id, state, requested_by, subject_user_id, action, payload, channel, reason, expires_at, resolved_at, resolved_by, resolution_reason, created_at, updated_at";

function timestampLiteral(date: Date): string {
  return sqlText(date.toISOString());
}

export interface ApprovalQueueOptions {
  readonly agentId: string;
}

export class PgApprovalQueue implements ApprovalQueue {
  private readonly runtime: IAgentRuntime;
  private readonly agentId: string;

  constructor(runtime: IAgentRuntime, options: ApprovalQueueOptions) {
    this.runtime = runtime;
    this.agentId = options.agentId;
  }

  async enqueue(input: ApprovalEnqueueInput): Promise<ApprovalRequest> {
    const payload = validateApprovalPayload(input.payload, "enqueue payload");
    if (input.action !== payload.action) {
      throw new Error(
        `[ApprovalQueue] payload action ${payload.action} does not match request action ${input.action}`,
      );
    }
    const id = randomUUID();
    const now = new Date();
    const sql = `INSERT INTO approval_requests (
        id, state, requested_by, subject_user_id, action, payload, channel, reason,
        expires_at, resolved_at, resolved_by, resolution_reason,
        agent_id, created_at, updated_at
      ) VALUES (
        ${sqlText(id)},
        ${sqlText("pending")},
        ${sqlText(input.requestedBy)},
        ${sqlText(input.subjectUserId)},
        ${sqlText(input.action)},
        ${sqlJson(payload)},
        ${sqlText(input.channel)},
        ${sqlText(input.reason)},
        ${timestampLiteral(input.expiresAt)},
        NULL, NULL, NULL,
        ${sqlText(this.agentId)},
        ${timestampLiteral(now)},
        ${timestampLiteral(now)}
      ) RETURNING ${SELECT_COLUMNS}`;
    const rows = await executeRawSql(this.runtime, sql);
    if (rows.length === 0) {
      throw new Error("[ApprovalQueue] enqueue returned no rows");
    }
    logger.info(
      `[ApprovalQueue] enqueued ${input.action} for ${input.subjectUserId} as ${id}`,
    );
    return rowToRequest(rows[0]);
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

  private async fetchById(id: string): Promise<ApprovalRequest | null> {
    const sql = `SELECT ${SELECT_COLUMNS} FROM approval_requests
      WHERE id = ${sqlText(id)} AND agent_id = ${sqlText(this.agentId)}
      LIMIT 1`;
    const rows = await executeRawSql(this.runtime, sql);
    if (rows.length === 0) return null;
    return rowToRequest(rows[0]);
  }

  private async transitionWithResolution(
    id: string,
    target: ApprovalRequestState,
    resolution: ApprovalResolution,
  ): Promise<ApprovalRequest> {
    const current = await this.fetchById(id);
    if (!current) throw new ApprovalNotFoundError(id);
    assertTransition(id, current.state, target);
    const now = new Date();
    const sql = `UPDATE approval_requests
      SET state = ${sqlText(target)},
          resolved_at = ${timestampLiteral(now)},
          resolved_by = ${sqlText(resolution.resolvedBy)},
          resolution_reason = ${sqlText(resolution.resolutionReason)},
          updated_at = ${timestampLiteral(now)}
      WHERE id = ${sqlText(id)} AND agent_id = ${sqlText(this.agentId)}
      RETURNING ${SELECT_COLUMNS}`;
    const rows = await executeRawSql(this.runtime, sql);
    if (rows.length === 0) {
      throw new ApprovalNotFoundError(id);
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
    assertTransition(id, current.state, target);
    const now = new Date();
    const sql = `UPDATE approval_requests
      SET state = ${sqlText(target)},
          updated_at = ${timestampLiteral(now)}
      WHERE id = ${sqlText(id)} AND agent_id = ${sqlText(this.agentId)}
      RETURNING ${SELECT_COLUMNS}`;
    const rows = await executeRawSql(this.runtime, sql);
    if (rows.length === 0) {
      throw new ApprovalNotFoundError(id);
    }
    logger.info(`[ApprovalQueue] ${current.state} -> ${target} (${id})`);
    return rowToRequest(rows[0]);
  }
}

export function createApprovalQueue(
  runtime: IAgentRuntime,
  options: ApprovalQueueOptions,
): ApprovalQueue {
  return new PgApprovalQueue(runtime, options);
}
