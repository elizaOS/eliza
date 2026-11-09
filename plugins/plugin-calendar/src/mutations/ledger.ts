/**
 * Transactional calendar-mutation claim and receipt store. Approval rows stay
 * the queue; this ledger adds exact-payload binding and crash-safe side-effect
 * evidence without introducing another scheduler or retry loop.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarEventAttendee,
  LifeOpsCalendarProvider,
} from "@elizaos/contracts";
import { ElizaError, type IAgentRuntime, stableStringify } from "@elizaos/core";
import {
  executeRawSql,
  executeRawSqlTx,
  parseJsonRecord,
  sqlJson,
  sqlText,
  type TransactionalDb,
  toText,
  withCalendarTransaction,
} from "../internal/sql.js";
import type {
  CalendarMutationApproval,
  CalendarMutationAttempt,
  CalendarMutationFailure,
  CalendarMutationOperation,
  CalendarMutationReceipt,
  CalendarMutationReconciliation,
  CalendarMutationState,
} from "./types.js";

export type CalendarMutationClaimResult =
  | { readonly kind: "claimed"; readonly attempt: CalendarMutationAttempt }
  | {
      readonly kind: "already_succeeded";
      readonly attempt: CalendarMutationAttempt;
    }
  | {
      readonly kind: "blocked";
      readonly reason: "in_flight" | "ambiguous";
      readonly attempt: CalendarMutationAttempt;
    }
  | {
      readonly kind: "invalidated";
      readonly attempt: CalendarMutationAttempt;
    };

const VALID_STATES: ReadonlySet<CalendarMutationState> = new Set([
  "prepared",
  "executing",
  "succeeded",
  "failed_retryable",
  "ambiguous",
  "invalidated",
]);

const VALID_OPERATIONS: ReadonlySet<CalendarMutationOperation> = new Set([
  "schedule_event",
  "modify_event",
  "cancel_event",
]);

const VALID_PROVIDERS: ReadonlySet<string> = new Set([
  "google",
  "microsoft",
  "apple_calendar",
  "ics",
  "eliza",
]);

const SELECT_COLUMNS = [
  "id",
  "agent_id",
  "approval_request_id",
  "approval_sha256",
  "operation_key",
  "operation",
  "state",
  "attempt_count",
  "executor_session_id",
  "claim_token",
  "provider",
  "source_id",
  "calendar_id",
  "event_id",
  "provider_event_id",
  "provider_version",
  "receipt_json",
  "last_failure_json",
  "first_attempted_at",
  "last_attempted_at",
  "completed_at",
  "created_at",
  "updated_at",
].join(", ");

const executionSessions = new WeakMap<IAgentRuntime, string>();

function executionSessionId(runtime: IAgentRuntime): string {
  const existing = executionSessions.get(runtime);
  if (existing) return existing;
  const created = randomUUID();
  executionSessions.set(runtime, created);
  return created;
}

function invariant(
  code: string,
  message: string,
  context: Record<string, unknown> = {},
): ElizaError {
  return new ElizaError(`[CalendarMutationLedger] ${message}`, {
    code,
    context,
    severity: "fatal",
  });
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return toText(value);
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || value === "") return null;
  return parseJsonRecord(value);
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw invariant(
      "CALENDAR_MUTATION_PERSISTED_ROW_INVALID",
      `${field} must be a non-negative integer`,
      { field, value },
    );
  }
  return parsed;
}

function receiptInvariant(
  message: string,
  context: Record<string, unknown>,
): never {
  throw invariant(
    "CALENDAR_MUTATION_PERSISTED_RECEIPT_INVALID",
    message,
    context,
  );
}

function receiptString(
  record: Record<string, unknown>,
  field: string,
  options: { nonEmpty?: boolean; timestamp?: boolean } = {},
): string {
  const value = record[field];
  if (
    typeof value !== "string" ||
    (options.nonEmpty && !value.trim()) ||
    (options.timestamp && !Number.isFinite(Date.parse(value)))
  ) {
    receiptInvariant("persisted event snapshot contains an invalid string", {
      field,
      value,
    });
  }
  return value;
}

function receiptNullableString(
  record: Record<string, unknown>,
  field: string,
): string | null {
  const value = record[field];
  if (value === null || typeof value === "string") return value;
  return receiptInvariant(
    "persisted event snapshot contains an invalid nullable string",
    { field, value },
  );
}

function receiptOptionalString(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  if (value === undefined || typeof value === "string") return value;
  return receiptInvariant(
    "persisted event snapshot contains an invalid optional string",
    { field, value },
  );
}

function receiptRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return receiptInvariant(
      "persisted event snapshot contains an invalid object",
      { field, value },
    );
  }
  return value as Record<string, unknown>;
}

function parseSnapshotProvider(value: unknown): LifeOpsCalendarProvider {
  switch (value) {
    case "google":
    case "microsoft":
    case "apple_calendar":
    case "ics":
    case "eliza":
      return value;
    default:
      return receiptInvariant(
        "persisted event snapshot contains an invalid provider",
        { value },
      );
  }
}

function parseSnapshotSide(value: unknown): LifeOpsCalendarEvent["side"] {
  if (value === "owner" || value === "agent") return value;
  return receiptInvariant(
    "persisted event snapshot contains an invalid connector side",
    { value },
  );
}

function parseSnapshotAttendee(
  value: unknown,
  index: number,
): LifeOpsCalendarEventAttendee {
  const attendee = receiptRecord(value, `eventSnapshot.attendees[${index}]`);
  const email = receiptNullableString(attendee, "email");
  const displayName = receiptNullableString(attendee, "displayName");
  const responseStatus = receiptNullableString(attendee, "responseStatus");
  if (
    typeof attendee.self !== "boolean" ||
    typeof attendee.organizer !== "boolean" ||
    typeof attendee.optional !== "boolean"
  ) {
    return receiptInvariant(
      "persisted event snapshot contains an invalid attendee",
      { index, attendee },
    );
  }
  return {
    email,
    displayName,
    responseStatus,
    self: attendee.self,
    organizer: attendee.organizer,
    optional: attendee.optional,
  };
}

function parseEventSnapshot(value: unknown): LifeOpsCalendarEvent | null {
  if (value === null) return null;
  const event = receiptRecord(value, "eventSnapshot");
  const recurrenceValue = event.recurrence;
  const recurrence =
    recurrenceValue === undefined || recurrenceValue === null
      ? recurrenceValue
      : Array.isArray(recurrenceValue) &&
          recurrenceValue.every((entry) => typeof entry === "string")
        ? recurrenceValue
        : receiptInvariant(
            "persisted event snapshot contains invalid recurrence data",
            { recurrence: recurrenceValue },
          );
  const recurringEventId =
    event.recurringEventId === undefined
      ? undefined
      : receiptNullableString(event, "recurringEventId");
  if (typeof event.isAllDay !== "boolean" || !Array.isArray(event.attendees)) {
    return receiptInvariant(
      "persisted event snapshot contains invalid event fields",
      { event },
    );
  }
  const organizer =
    event.organizer === null
      ? null
      : receiptRecord(event.organizer, "eventSnapshot.organizer");
  const metadata = receiptRecord(event.metadata, "eventSnapshot.metadata");
  const calendarSummary = receiptOptionalString(event, "calendarSummary");
  const connectorAccountId = receiptOptionalString(event, "connectorAccountId");
  const grantId = receiptOptionalString(event, "grantId");
  const accountEmail = receiptOptionalString(event, "accountEmail");
  return {
    id: receiptString(event, "id", { nonEmpty: true }),
    externalId: receiptString(event, "externalId", { nonEmpty: true }),
    agentId: receiptString(event, "agentId", { nonEmpty: true }),
    provider: parseSnapshotProvider(event.provider),
    side: parseSnapshotSide(event.side),
    calendarId: receiptString(event, "calendarId", { nonEmpty: true }),
    title: receiptString(event, "title"),
    description: receiptString(event, "description"),
    location: receiptString(event, "location"),
    status: receiptString(event, "status"),
    startAt: receiptString(event, "startAt", { timestamp: true }),
    endAt: receiptString(event, "endAt", { timestamp: true }),
    isAllDay: event.isAllDay,
    timezone: receiptNullableString(event, "timezone"),
    htmlLink: receiptNullableString(event, "htmlLink"),
    conferenceLink: receiptNullableString(event, "conferenceLink"),
    organizer,
    attendees: event.attendees.map(parseSnapshotAttendee),
    metadata,
    ...(recurrence !== undefined ? { recurrence } : {}),
    ...(recurringEventId !== undefined ? { recurringEventId } : {}),
    syncedAt: receiptString(event, "syncedAt", { timestamp: true }),
    updatedAt: receiptString(event, "updatedAt", { timestamp: true }),
    ...(calendarSummary !== undefined ? { calendarSummary } : {}),
    ...(connectorAccountId !== undefined ? { connectorAccountId } : {}),
    ...(grantId !== undefined ? { grantId } : {}),
    ...(accountEmail !== undefined ? { accountEmail } : {}),
  };
}

function parseFailure(value: unknown): CalendarMutationFailure | null {
  const record = optionalRecord(value);
  if (!record) return null;
  if (
    typeof record.code !== "string" ||
    !record.code.trim() ||
    typeof record.message !== "string" ||
    typeof record.retryable !== "boolean"
  ) {
    throw invariant(
      "CALENDAR_MUTATION_PERSISTED_FAILURE_INVALID",
      "persisted mutation failure is incomplete",
      { failure: record },
    );
  }
  const details =
    record.details &&
    typeof record.details === "object" &&
    !Array.isArray(record.details)
      ? (record.details as Record<string, unknown>)
      : undefined;
  return {
    code: record.code,
    message: record.message,
    retryable: record.retryable,
    ...(details ? { details } : {}),
  };
}

function parseReceipt(value: unknown): CalendarMutationReceipt | null {
  const record = optionalRecord(value);
  if (!record) return null;
  const operation = record.operation as CalendarMutationOperation;
  const provider = record.provider as LifeOpsCalendarProvider;
  const recurrenceScope =
    record.recurrenceScope === null ||
    record.recurrenceScope === "instance" ||
    record.recurrenceScope === "this_and_following" ||
    record.recurrenceScope === "series"
      ? record.recurrenceScope
      : undefined;
  const cancellationMode =
    record.cancellationMode === null ||
    record.cancellationMode === "organizer_cancel" ||
    record.cancellationMode === "decline_invitation" ||
    record.cancellationMode === "remove_private_copy"
      ? record.cancellationMode
      : undefined;
  const accessLevel =
    record.accessLevel === undefined
      ? "readable"
      : record.accessLevel === "readable" || record.accessLevel === "write_only"
        ? record.accessLevel
        : undefined;
  const readBackAvailable =
    record.readBackAvailable === undefined
      ? true
      : typeof record.readBackAvailable === "boolean"
        ? record.readBackAvailable
        : undefined;
  const eventId =
    record.eventId === null || typeof record.eventId === "string"
      ? record.eventId
      : undefined;
  const providerEventId =
    record.providerEventId === null ||
    typeof record.providerEventId === "string"
      ? record.providerEventId
      : undefined;
  const eventSnapshot =
    record.eventSnapshot === undefined
      ? undefined
      : parseEventSnapshot(record.eventSnapshot);
  if (
    !VALID_OPERATIONS.has(operation) ||
    !VALID_PROVIDERS.has(provider) ||
    typeof record.sourceId !== "string" ||
    !record.sourceId ||
    typeof record.calendarId !== "string" ||
    !record.calendarId ||
    eventId === undefined ||
    providerEventId === undefined ||
    eventSnapshot === undefined ||
    accessLevel === undefined ||
    readBackAvailable === undefined ||
    (accessLevel === "write_only" &&
      (readBackAvailable ||
        eventId !== null ||
        providerEventId !== null ||
        eventSnapshot !== null ||
        provider !== "apple_calendar")) ||
    (accessLevel === "readable" &&
      (!readBackAvailable ||
        !eventId ||
        !providerEventId ||
        !eventSnapshot ||
        eventSnapshot.id !== eventId ||
        eventSnapshot.externalId !== providerEventId ||
        eventSnapshot.provider !== provider ||
        eventSnapshot.calendarId !== record.calendarId)) ||
    (record.providerVersion !== null &&
      typeof record.providerVersion !== "string") ||
    recurrenceScope === undefined ||
    cancellationMode === undefined ||
    typeof record.acceptedAt !== "string" ||
    !Number.isFinite(Date.parse(record.acceptedAt))
  ) {
    throw invariant(
      "CALENDAR_MUTATION_PERSISTED_RECEIPT_INVALID",
      "persisted provider receipt is incomplete",
      { receipt: record },
    );
  }
  return {
    operation,
    provider,
    sourceId: record.sourceId,
    calendarId: record.calendarId,
    eventId,
    providerEventId,
    providerVersion: record.providerVersion,
    readBackAvailable,
    accessLevel,
    eventSnapshot,
    recurrenceScope,
    cancellationMode,
    acceptedAt: record.acceptedAt,
  };
}

function rowToAttempt(row: Record<string, unknown>): CalendarMutationAttempt {
  const state = toText(row.state) as CalendarMutationState;
  const operation = toText(row.operation) as CalendarMutationOperation;
  const agentId = toText(row.agent_id);
  const receipt = parseReceipt(row.receipt_json);
  if (!VALID_STATES.has(state) || !VALID_OPERATIONS.has(operation)) {
    throw invariant(
      "CALENDAR_MUTATION_PERSISTED_ROW_INVALID",
      "persisted mutation state or operation is unknown",
      { state, operation },
    );
  }
  if (
    receipt?.eventSnapshot &&
    (receipt.eventSnapshot.agentId !== agentId ||
      receipt.eventSnapshot.grantId !== receipt.sourceId)
  ) {
    throw invariant(
      "CALENDAR_MUTATION_PERSISTED_RECEIPT_INVALID",
      "persisted event snapshot crosses its mutation tenant or source binding",
      {
        agentId,
        snapshotAgentId: receipt.eventSnapshot.agentId,
        sourceId: receipt.sourceId,
        snapshotGrantId: receipt.eventSnapshot.grantId,
      },
    );
  }
  return {
    id: toText(row.id),
    agentId,
    approvalRequestId: toText(row.approval_request_id),
    approvalSha256: toText(row.approval_sha256),
    operationKey: toText(row.operation_key),
    operation,
    state,
    attemptCount: requiredNonNegativeInteger(
      row.attempt_count,
      "attempt_count",
    ),
    executorSessionId: optionalText(row.executor_session_id),
    claimToken: optionalText(row.claim_token),
    provider: optionalText(row.provider),
    sourceId: optionalText(row.source_id),
    calendarId: optionalText(row.calendar_id),
    eventId: optionalText(row.event_id),
    providerEventId: optionalText(row.provider_event_id),
    providerVersion: optionalText(row.provider_version),
    receipt,
    lastFailure: parseFailure(row.last_failure_json),
    firstAttemptedAt: optionalText(row.first_attempted_at),
    lastAttemptedAt: optionalText(row.last_attempted_at),
    completedAt: optionalText(row.completed_at),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function requireCalendarMutationOperation(
  request: CalendarMutationApproval,
): CalendarMutationOperation {
  if (
    request.action !== "schedule_event" &&
    request.action !== "modify_event" &&
    request.action !== "cancel_event"
  ) {
    throw invariant(
      "CALENDAR_MUTATION_ACTION_UNSUPPORTED",
      `approval ${request.id} is not a calendar mutation`,
      { requestId: request.id, action: request.action },
    );
  }
  if (request.payload.action !== request.action) {
    throw invariant(
      "CALENDAR_MUTATION_ACTION_MISMATCH",
      "approval action and payload action do not match",
      {
        requestId: request.id,
        action: request.action,
        payloadAction: request.payload.action,
      },
    );
  }
  return request.action;
}

export function calendarMutationApprovalSha256(
  request: CalendarMutationApproval,
): string {
  requireCalendarMutationOperation(request);
  return calendarMutationApprovalIdentitySha256({
    id: request.id,
    requestedBy: request.requestedBy,
    subjectUserId: request.subjectUserId,
    action: request.action,
    payload: request.payload,
    channel: request.channel,
    reason: request.reason,
    idempotencyKey: request.idempotencyKey,
    expiresAt: request.expiresAt.toISOString(),
  });
}

function calendarMutationApprovalIdentitySha256(identity: {
  readonly id: string;
  readonly requestedBy: string;
  readonly subjectUserId: string;
  readonly action: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly channel: string;
  readonly reason: string;
  readonly idempotencyKey: string | null;
  readonly expiresAt: string;
}): string {
  return createHash("sha256").update(stableStringify(identity)).digest("hex");
}

export function calendarMutationOperationKey(approvalSha256: string): string {
  return `calendar-mutation:v1:${approvalSha256}`;
}

async function byApprovalRequestIdTx(
  tx: TransactionalDb,
  agentId: string,
  approvalRequestId: string,
): Promise<CalendarMutationAttempt | null> {
  const rows = await executeRawSqlTx(
    tx,
    `SELECT ${SELECT_COLUMNS}
       FROM app_lifeops.life_calendar_mutation_attempts
      WHERE agent_id = ${sqlText(agentId)}
        AND approval_request_id = ${sqlText(approvalRequestId)}
      LIMIT 1
      FOR UPDATE`,
  );
  return rows[0] ? rowToAttempt(rows[0]) : null;
}

async function assertPersistedApprovalBindingTx(
  tx: TransactionalDb,
  args: {
    readonly agentId: string;
    readonly request: CalendarMutationApproval;
    readonly approvalSha256: string;
  },
): Promise<void> {
  const rows = await executeRawSqlTx(
    tx,
    `SELECT id, requested_by, subject_user_id, action, payload, channel, reason,
            idempotency_key, expires_at
       FROM approval_requests
      WHERE id = ${sqlText(args.request.id)}
        AND agent_id = ${sqlText(args.agentId)}
      LIMIT 1
      FOR UPDATE`,
  );
  const persisted = rows[0];
  if (!persisted) {
    throw invariant(
      "CALENDAR_MUTATION_APPROVAL_NOT_FOUND",
      `approval ${args.request.id} does not exist`,
      { requestId: args.request.id },
    );
  }
  const expiresAt = new Date(toText(persisted.expires_at));
  if (!Number.isFinite(expiresAt.getTime())) {
    throw invariant(
      "CALENDAR_MUTATION_APPROVAL_PERSISTED_INVALID",
      `approval ${args.request.id} has an invalid expiry`,
      { requestId: args.request.id },
    );
  }
  const persistedSha256 = calendarMutationApprovalIdentitySha256({
    id: toText(persisted.id),
    requestedBy: toText(persisted.requested_by),
    subjectUserId: toText(persisted.subject_user_id),
    action: toText(persisted.action),
    payload: parseJsonRecord(persisted.payload),
    channel: toText(persisted.channel),
    reason: toText(persisted.reason),
    idempotencyKey: optionalText(persisted.idempotency_key),
    expiresAt: expiresAt.toISOString(),
  });
  if (persistedSha256 !== args.approvalSha256) {
    throw invariant(
      "CALENDAR_MUTATION_APPROVAL_CHANGED",
      "execution input differs from the persisted approved calendar mutation",
      {
        requestId: args.request.id,
        persistedApprovalSha256: persistedSha256,
        executionApprovalSha256: args.approvalSha256,
      },
    );
  }
}

async function prepareTx(
  tx: TransactionalDb,
  args: {
    readonly agentId: string;
    readonly request: CalendarMutationApproval;
    readonly approvalSha256: string;
    readonly operation: CalendarMutationOperation;
  },
): Promise<CalendarMutationAttempt> {
  const operationKey = calendarMutationOperationKey(args.approvalSha256);
  const now = new Date().toISOString();
  await assertPersistedApprovalBindingTx(tx, args);
  await executeRawSqlTx(
    tx,
    `INSERT INTO app_lifeops.life_calendar_mutation_attempts (
       id, agent_id, approval_request_id, approval_sha256, operation_key,
       operation, state, attempt_count, executor_session_id, claim_token,
       provider, source_id, calendar_id, event_id, provider_event_id,
       provider_version, receipt_json, last_failure_json, first_attempted_at,
       last_attempted_at, completed_at, created_at, updated_at
     ) VALUES (
       ${sqlText(randomUUID())},
       ${sqlText(args.agentId)},
       ${sqlText(args.request.id)},
       ${sqlText(args.approvalSha256)},
       ${sqlText(operationKey)},
       ${sqlText(args.operation)},
       ${sqlText("prepared")},
       0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL,
       ${sqlText(now)},
       ${sqlText(now)}
     )
     ON CONFLICT (agent_id, approval_request_id) DO NOTHING`,
  );
  const attempt = await byApprovalRequestIdTx(
    tx,
    args.agentId,
    args.request.id,
  );
  if (!attempt) {
    throw invariant(
      "CALENDAR_MUTATION_PREPARE_FAILED",
      "preparation returned no durable attempt",
      { requestId: args.request.id },
    );
  }
  if (
    attempt.approvalSha256 !== args.approvalSha256 ||
    attempt.operationKey !== operationKey ||
    attempt.operation !== args.operation
  ) {
    throw invariant(
      "CALENDAR_MUTATION_APPROVAL_CHANGED",
      "durable mutation attempt is bound to different approval content",
      {
        requestId: args.request.id,
        attemptId: attempt.id,
        expectedApprovalSha256: attempt.approvalSha256,
        actualApprovalSha256: args.approvalSha256,
      },
    );
  }
  return attempt;
}

/**
 * Moves the approval of an unknown-outcome attempt to reconciliation_required
 * and records the ledger attempt as its execution, so the approval queue's
 * reconcile path can address it. Running rows carry no execution metadata:
 * the ledger, not the generic recovery, decides what an executing row means.
 */
async function quarantineApprovalTx(
  tx: TransactionalDb,
  agentId: string,
  attempt: CalendarMutationAttempt,
  failure: CalendarMutationFailure,
): Promise<void> {
  const now = new Date().toISOString();
  const startedAt = attempt.lastAttemptedAt ?? now;
  await executeRawSqlTx(
    tx,
    `UPDATE approval_requests
        SET state = ${sqlText("reconciliation_required")},
            execution_attempt_id = ${sqlText(attempt.id)},
            execution_provider = ${sqlText(attempt.provider ?? "calendar")},
            provider_idempotency_key = ${sqlText(attempt.operationKey)},
            execution_claimed_at = ${sqlText(startedAt)},
            dispatch_started_at = ${sqlText(startedAt)},
            execution_error = ${sqlText(failure.message)},
            updated_at = ${sqlText(now)}
      WHERE id = ${sqlText(attempt.approvalRequestId)}
        AND agent_id = ${sqlText(agentId)}
        AND state = ${sqlText("executing")}`,
  );
}

export class CalendarMutationLedger {
  private readonly sessionId: string;

  constructor(private readonly runtime: IAgentRuntime) {
    this.sessionId = executionSessionId(runtime);
  }

  async byApprovalRequestId(
    approvalRequestId: string,
  ): Promise<CalendarMutationAttempt | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT ${SELECT_COLUMNS}
         FROM app_lifeops.life_calendar_mutation_attempts
        WHERE agent_id = ${sqlText(this.runtime.agentId)}
          AND approval_request_id = ${sqlText(approvalRequestId)}
        LIMIT 1`,
    );
    return rows[0] ? rowToAttempt(rows[0]) : null;
  }

  async inspect(
    request: CalendarMutationApproval,
  ): Promise<CalendarMutationClaimResult | null> {
    const operation = requireCalendarMutationOperation(request);
    const approvalSha256 = calendarMutationApprovalSha256(request);
    return withCalendarTransaction(this.runtime, async (tx) => {
      await assertPersistedApprovalBindingTx(tx, {
        agentId: String(this.runtime.agentId),
        request,
        approvalSha256,
      });
      const attempt = await byApprovalRequestIdTx(
        tx,
        String(this.runtime.agentId),
        request.id,
      );
      if (!attempt) return null;
      this.assertBinding(attempt, operation, approvalSha256);
      return this.classifyExistingTx(tx, attempt);
    });
  }

  async claim(
    request: CalendarMutationApproval,
  ): Promise<CalendarMutationClaimResult> {
    const operation = requireCalendarMutationOperation(request);
    const approvalSha256 = calendarMutationApprovalSha256(request);
    return withCalendarTransaction(this.runtime, async (tx) => {
      const attempt = await prepareTx(tx, {
        agentId: String(this.runtime.agentId),
        request,
        approvalSha256,
        operation,
      });
      this.assertBinding(attempt, operation, approvalSha256);
      const existing = await this.classifyExistingTx(tx, attempt);
      if (existing) return existing;

      const now = new Date().toISOString();
      const claimToken = randomUUID();
      // A provider rejection leaves the approval retryable; rows written
      // before that rule still sit in executing.
      const approvalStates =
        attempt.state === "failed_retryable" && attempt.attemptCount > 0
          ? ["retryable", "executing"]
          : ["approved"];
      const approvalRows = await executeRawSqlTx(
        tx,
        `UPDATE approval_requests
            SET state = ${sqlText("executing")},
                execution_attempt_id = NULL,
                execution_provider = NULL,
                provider_idempotency_key = NULL,
                execution_claimed_at = NULL,
                dispatch_started_at = NULL,
                provider_receipt = NULL,
                execution_error = NULL,
                updated_at = ${sqlText(now)}
          WHERE id = ${sqlText(request.id)}
            AND agent_id = ${sqlText(this.runtime.agentId)}
            AND state IN (${approvalStates.map((state) => sqlText(state)).join(", ")})
          RETURNING id`,
      );
      if (approvalRows.length === 0) {
        const latest = await byApprovalRequestIdTx(
          tx,
          String(this.runtime.agentId),
          request.id,
        );
        if (latest) {
          const classified = await this.classifyExistingTx(tx, latest);
          if (classified) return classified;
        }
        throw invariant(
          "CALENDAR_MUTATION_APPROVAL_NOT_CLAIMABLE",
          `approval ${request.id} cannot be claimed from ${approvalStates.join(" or ")}`,
          { requestId: request.id, expectedStates: approvalStates },
        );
      }
      const rows = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_calendar_mutation_attempts
            SET state = ${sqlText("executing")},
                attempt_count = attempt_count + 1,
                executor_session_id = ${sqlText(this.sessionId)},
                claim_token = ${sqlText(claimToken)},
                first_attempted_at = COALESCE(first_attempted_at, ${sqlText(now)}),
                last_attempted_at = ${sqlText(now)},
                last_failure_json = NULL,
                updated_at = ${sqlText(now)}
          WHERE id = ${sqlText(attempt.id)}
            AND agent_id = ${sqlText(this.runtime.agentId)}
            AND state IN (${sqlText("prepared")}, ${sqlText("failed_retryable")})
          RETURNING ${SELECT_COLUMNS}`,
      );
      if (!rows[0]) {
        throw invariant(
          "CALENDAR_MUTATION_CLAIM_CONFLICT",
          `attempt ${attempt.id} lost its claim`,
          { attemptId: attempt.id, requestId: request.id },
        );
      }
      return { kind: "claimed", attempt: rowToAttempt(rows[0]) };
    });
  }

  async invalidate(
    request: CalendarMutationApproval,
    failure: CalendarMutationFailure,
  ): Promise<CalendarMutationClaimResult> {
    const operation = requireCalendarMutationOperation(request);
    const approvalSha256 = calendarMutationApprovalSha256(request);
    return withCalendarTransaction(this.runtime, async (tx) => {
      const attempt = await prepareTx(tx, {
        agentId: String(this.runtime.agentId),
        request,
        approvalSha256,
        operation,
      });
      this.assertBinding(attempt, operation, approvalSha256);
      const classified = await this.classifyExistingTx(tx, attempt);
      if (classified) return classified;
      const now = new Date().toISOString();
      // Same states claim() accepts: a retry after a provider rejection may
      // find its approval in retryable, or in executing on rows written
      // before that rule.
      const approvalStates =
        attempt.state === "failed_retryable" && attempt.attemptCount > 0
          ? ["retryable", "executing"]
          : ["approved"];
      const approvals = await executeRawSqlTx(
        tx,
        `UPDATE approval_requests
            SET state = ${sqlText("expired")},
                resolved_at = ${sqlText(now)},
                resolved_by = ${sqlText("SYSTEM")},
                resolution_reason = ${sqlText(failure.message)},
                updated_at = ${sqlText(now)}
          WHERE id = ${sqlText(request.id)}
            AND agent_id = ${sqlText(this.runtime.agentId)}
            AND state IN (${approvalStates.map((state) => sqlText(state)).join(", ")})
          RETURNING id`,
      );
      if (approvals.length === 0) {
        throw invariant(
          "CALENDAR_MUTATION_INVALIDATION_CONFLICT",
          `approval ${request.id} cannot be invalidated outside ${approvalStates.join(" or ")}`,
          { requestId: request.id, attemptId: attempt.id },
        );
      }
      const rows = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_calendar_mutation_attempts
            SET state = ${sqlText("invalidated")},
                last_failure_json = ${sqlJson(failure)},
                completed_at = ${sqlText(now)},
                updated_at = ${sqlText(now)}
          WHERE id = ${sqlText(attempt.id)}
            AND agent_id = ${sqlText(this.runtime.agentId)}
            AND state IN (${sqlText("prepared")}, ${sqlText("failed_retryable")})
          RETURNING ${SELECT_COLUMNS}`,
      );
      if (!rows[0]) {
        throw invariant(
          "CALENDAR_MUTATION_INVALIDATION_CONFLICT",
          `attempt ${attempt.id} cannot be invalidated from ${attempt.state}`,
          { attemptId: attempt.id, state: attempt.state },
        );
      }
      return { kind: "invalidated", attempt: rowToAttempt(rows[0]) };
    });
  }

  async recordPreflightRetryable(
    request: CalendarMutationApproval,
    failure: CalendarMutationFailure,
  ): Promise<CalendarMutationAttempt> {
    const operation = requireCalendarMutationOperation(request);
    const approvalSha256 = calendarMutationApprovalSha256(request);
    return withCalendarTransaction(this.runtime, async (tx) => {
      const attempt = await prepareTx(tx, {
        agentId: String(this.runtime.agentId),
        request,
        approvalSha256,
        operation,
      });
      this.assertBinding(attempt, operation, approvalSha256);
      if (
        attempt.state === "succeeded" ||
        attempt.state === "ambiguous" ||
        attempt.state === "invalidated" ||
        attempt.state === "executing"
      ) {
        return attempt;
      }
      const rows = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_calendar_mutation_attempts
            SET state = ${sqlText("failed_retryable")},
                last_failure_json = ${sqlJson(failure)},
                updated_at = ${sqlText(new Date().toISOString())}
          WHERE id = ${sqlText(attempt.id)}
            AND agent_id = ${sqlText(this.runtime.agentId)}
            AND state IN (${sqlText("prepared")}, ${sqlText("failed_retryable")})
          RETURNING ${SELECT_COLUMNS}`,
      );
      if (!rows[0]) {
        throw invariant(
          "CALENDAR_MUTATION_PREFLIGHT_PERSIST_CONFLICT",
          `attempt ${attempt.id} cannot record a retryable preflight failure`,
          { attemptId: attempt.id, state: attempt.state },
        );
      }
      return rowToAttempt(rows[0]);
    });
  }

  async recordSuccess(
    attempt: CalendarMutationAttempt,
    receipt: CalendarMutationReceipt,
  ): Promise<CalendarMutationAttempt> {
    return withCalendarTransaction(this.runtime, async (tx) => {
      const now = new Date().toISOString();
      const rows = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_calendar_mutation_attempts
            SET state = ${sqlText("succeeded")},
                provider = ${sqlText(receipt.provider)},
                source_id = ${sqlText(receipt.sourceId)},
                calendar_id = ${sqlText(receipt.calendarId)},
                event_id = ${sqlText(receipt.eventId)},
                provider_event_id = ${sqlText(receipt.providerEventId)},
                provider_version = ${sqlText(receipt.providerVersion)},
                receipt_json = ${sqlJson(receipt)},
                completed_at = ${sqlText(now)},
                updated_at = ${sqlText(now)}
          WHERE id = ${sqlText(attempt.id)}
            AND agent_id = ${sqlText(this.runtime.agentId)}
            AND state = ${sqlText("executing")}
            AND executor_session_id = ${sqlText(this.sessionId)}
            AND claim_token = ${sqlText(attempt.claimToken)}
          RETURNING ${SELECT_COLUMNS}`,
      );
      if (!rows[0]) {
        const current = await byApprovalRequestIdTx(
          tx,
          String(this.runtime.agentId),
          attempt.approvalRequestId,
        );
        if (current?.state === "ambiguous") return current;
        throw invariant(
          "CALENDAR_MUTATION_RECEIPT_PERSIST_CONFLICT",
          `attempt ${attempt.id} cannot persist success`,
          { attemptId: attempt.id, state: current?.state ?? "missing" },
        );
      }
      const approvals = await executeRawSqlTx(
        tx,
        `UPDATE approval_requests
            SET state = ${sqlText("done")},
                updated_at = ${sqlText(now)}
          WHERE id = ${sqlText(attempt.approvalRequestId)}
            AND agent_id = ${sqlText(this.runtime.agentId)}
            AND state = ${sqlText("executing")}
          RETURNING id`,
      );
      if (approvals.length === 0) {
        throw invariant(
          "CALENDAR_MUTATION_APPROVAL_COMPLETE_CONFLICT",
          `approval ${attempt.approvalRequestId} cannot complete`,
          { attemptId: attempt.id },
        );
      }
      return rowToAttempt(rows[0]);
    });
  }

  async recordNotAccepted(
    attempt: CalendarMutationAttempt,
    failure: CalendarMutationFailure,
  ): Promise<CalendarMutationAttempt> {
    return withCalendarTransaction(this.runtime, async (tx) => {
      const now = new Date().toISOString();
      const rows = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_calendar_mutation_attempts
            SET state = ${sqlText("failed_retryable")},
                last_failure_json = ${sqlJson(failure)},
                executor_session_id = NULL,
                claim_token = NULL,
                updated_at = ${sqlText(now)}
          WHERE id = ${sqlText(attempt.id)}
            AND agent_id = ${sqlText(this.runtime.agentId)}
            AND state = ${sqlText("executing")}
            AND executor_session_id = ${sqlText(this.sessionId)}
            AND claim_token = ${sqlText(attempt.claimToken)}
          RETURNING ${SELECT_COLUMNS}`,
      );
      if (!rows[0]) {
        const current = await byApprovalRequestIdTx(
          tx,
          String(this.runtime.agentId),
          attempt.approvalRequestId,
        );
        if (current?.state === "ambiguous") return current;
        throw invariant(
          "CALENDAR_MUTATION_REJECTION_PERSIST_CONFLICT",
          `attempt ${attempt.id} cannot record provider rejection`,
          { attemptId: attempt.id, state: current?.state ?? "missing" },
        );
      }
      // Nothing was applied, so the approval may be retried or rejected.
      await executeRawSqlTx(
        tx,
        `UPDATE approval_requests
            SET state = ${sqlText("retryable")},
                execution_error = ${sqlText(failure.message)},
                updated_at = ${sqlText(now)}
          WHERE id = ${sqlText(attempt.approvalRequestId)}
            AND agent_id = ${sqlText(this.runtime.agentId)}
            AND state = ${sqlText("executing")}`,
      );
      return rowToAttempt(rows[0]);
    });
  }

  async recordInvalidatedAfterClaim(
    attempt: CalendarMutationAttempt,
    failure: CalendarMutationFailure,
  ): Promise<CalendarMutationAttempt> {
    return withCalendarTransaction(this.runtime, async (tx) => {
      const now = new Date().toISOString();
      const rows = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_calendar_mutation_attempts
            SET state = ${sqlText("invalidated")},
                last_failure_json = ${sqlJson(failure)},
                completed_at = ${sqlText(now)},
                updated_at = ${sqlText(now)}
          WHERE id = ${sqlText(attempt.id)}
            AND agent_id = ${sqlText(this.runtime.agentId)}
            AND state = ${sqlText("executing")}
            AND executor_session_id = ${sqlText(this.sessionId)}
            AND claim_token = ${sqlText(attempt.claimToken)}
          RETURNING ${SELECT_COLUMNS}`,
      );
      if (!rows[0]) {
        const current = await byApprovalRequestIdTx(
          tx,
          String(this.runtime.agentId),
          attempt.approvalRequestId,
        );
        if (current?.state === "invalidated") return current;
        throw invariant(
          "CALENDAR_MUTATION_INVALIDATION_PERSIST_CONFLICT",
          `attempt ${attempt.id} cannot record post-claim invalidation`,
          { attemptId: attempt.id, state: current?.state ?? "missing" },
        );
      }
      // The approval store allows executing -> retryable -> expired, not a
      // direct expiry of a running row; nothing was sent, so take that path.
      await executeRawSqlTx(
        tx,
        `UPDATE approval_requests
            SET state = ${sqlText("retryable")},
                updated_at = ${sqlText(now)}
          WHERE id = ${sqlText(attempt.approvalRequestId)}
            AND agent_id = ${sqlText(this.runtime.agentId)}
            AND state = ${sqlText("executing")}`,
      );
      const approvals = await executeRawSqlTx(
        tx,
        `UPDATE approval_requests
            SET state = ${sqlText("expired")},
                resolved_at = ${sqlText(now)},
                resolved_by = ${sqlText("SYSTEM")},
                resolution_reason = ${sqlText(failure.message)},
                updated_at = ${sqlText(now)}
          WHERE id = ${sqlText(attempt.approvalRequestId)}
            AND agent_id = ${sqlText(this.runtime.agentId)}
            AND state = ${sqlText("retryable")}
          RETURNING id`,
      );
      if (approvals.length === 0) {
        throw invariant(
          "CALENDAR_MUTATION_APPROVAL_INVALIDATION_CONFLICT",
          `approval ${attempt.approvalRequestId} cannot be invalidated after claim`,
          { attemptId: attempt.id },
        );
      }
      return rowToAttempt(rows[0]);
    });
  }

  async recordAmbiguous(
    attempt: CalendarMutationAttempt,
    failure: CalendarMutationFailure,
  ): Promise<CalendarMutationAttempt> {
    return withCalendarTransaction(this.runtime, async (tx) => {
      const rows = await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_calendar_mutation_attempts
            SET state = ${sqlText("ambiguous")},
                last_failure_json = ${sqlJson(failure)},
                updated_at = ${sqlText(new Date().toISOString())}
          WHERE id = ${sqlText(attempt.id)}
            AND agent_id = ${sqlText(this.runtime.agentId)}
            AND state = ${sqlText("executing")}
            AND executor_session_id = ${sqlText(this.sessionId)}
            AND claim_token = ${sqlText(attempt.claimToken)}
          RETURNING ${SELECT_COLUMNS}`,
      );
      const ambiguous = rows[0]
        ? rowToAttempt(rows[0])
        : await byApprovalRequestIdTx(
            tx,
            String(this.runtime.agentId),
            attempt.approvalRequestId,
          );
      if (ambiguous?.state !== "ambiguous") {
        throw invariant(
          "CALENDAR_MUTATION_AMBIGUITY_PERSIST_CONFLICT",
          `attempt ${attempt.id} cannot record ambiguity`,
          { attemptId: attempt.id, state: ambiguous?.state ?? "missing" },
        );
      }
      await quarantineApprovalTx(
        tx,
        String(this.runtime.agentId),
        ambiguous,
        ambiguous.lastFailure ?? failure,
      );
      return ambiguous;
    });
  }

  /**
   * Settles an unknown outcome on evidence from outside the ledger: an owner
   * who checked the calendar, or a provider readback. "applied" completes the
   * approval; with a source-bound receipt the attempt also becomes succeeded,
   * and without one it keeps its unknown-outcome record because nothing more
   * is claimed from a done approval. "not_applied" makes both retryable.
   */
  async reconcile(
    approvalRequestId: string,
    evidence: CalendarMutationReconciliation,
  ): Promise<CalendarMutationAttempt> {
    return withCalendarTransaction(this.runtime, async (tx) => {
      const agentId = String(this.runtime.agentId);
      const attempt = await byApprovalRequestIdTx(
        tx,
        agentId,
        approvalRequestId,
      );
      if (attempt?.state !== "ambiguous") {
        throw invariant(
          "CALENDAR_MUTATION_NOT_AMBIGUOUS",
          `approval ${approvalRequestId} has no unknown calendar outcome to reconcile`,
          { approvalRequestId, state: attempt?.state ?? "missing" },
        );
      }
      if (attempt.lastFailure) {
        await quarantineApprovalTx(tx, agentId, attempt, attempt.lastFailure);
      }
      const now = new Date().toISOString();
      const applied = evidence.outcome === "applied";
      const receipt = applied ? evidence.receipt : null;
      if (receipt && receipt.operation !== attempt.operation) {
        throw invariant(
          "CALENDAR_MUTATION_RECONCILE_RECEIPT_INVALID",
          `receipt for ${receipt.operation} cannot settle ${attempt.operation}`,
          { attemptId: attempt.id },
        );
      }
      const approvals = await executeRawSqlTx(
        tx,
        `UPDATE approval_requests
            SET state = ${sqlText(applied ? "done" : "retryable")},
                provider_receipt = ${receipt ? sqlJson(receipt) : "provider_receipt"},
                execution_error = ${
                  applied
                    ? "NULL"
                    : sqlText("provider reconciliation confirmed non-delivery")
                },
                reconciliation_resolved_at = ${sqlText(now)},
                reconciliation_resolved_by = ${sqlText(evidence.reconciledBy)},
                reconciliation_reason = ${sqlText(evidence.reason)},
                updated_at = ${sqlText(now)}
          WHERE id = ${sqlText(approvalRequestId)}
            AND agent_id = ${sqlText(agentId)}
            AND state = ${sqlText("reconciliation_required")}
            AND execution_attempt_id = ${sqlText(attempt.id)}
          RETURNING id`,
      );
      if (approvals.length === 0) {
        throw invariant(
          "CALENDAR_MUTATION_RECONCILE_CONFLICT",
          `approval ${approvalRequestId} is not awaiting reconciliation of attempt ${attempt.id}`,
          { approvalRequestId, attemptId: attempt.id },
        );
      }
      if (applied && !receipt) return attempt;
      const rows = receipt
        ? await executeRawSqlTx(
            tx,
            `UPDATE app_lifeops.life_calendar_mutation_attempts
                SET state = ${sqlText("succeeded")},
                    provider = ${sqlText(receipt.provider)},
                    source_id = ${sqlText(receipt.sourceId)},
                    calendar_id = ${sqlText(receipt.calendarId)},
                    event_id = ${sqlText(receipt.eventId)},
                    provider_event_id = ${sqlText(receipt.providerEventId)},
                    provider_version = ${sqlText(receipt.providerVersion)},
                    receipt_json = ${sqlJson(receipt)},
                    completed_at = ${sqlText(now)},
                    updated_at = ${sqlText(now)}
              WHERE id = ${sqlText(attempt.id)}
                AND agent_id = ${sqlText(agentId)}
                AND state = ${sqlText("ambiguous")}
              RETURNING ${SELECT_COLUMNS}`,
          )
        : await executeRawSqlTx(
            tx,
            `UPDATE app_lifeops.life_calendar_mutation_attempts
                SET state = ${sqlText("failed_retryable")},
                    last_failure_json = ${sqlJson({
                      code: "CALENDAR_MUTATION_RECONCILED_NOT_APPLIED",
                      message: evidence.reason,
                      retryable: true,
                    } satisfies CalendarMutationFailure)},
                    executor_session_id = NULL,
                    claim_token = NULL,
                    updated_at = ${sqlText(now)}
              WHERE id = ${sqlText(attempt.id)}
                AND agent_id = ${sqlText(agentId)}
                AND state = ${sqlText("ambiguous")}
              RETURNING ${SELECT_COLUMNS}`,
          );
      if (!rows[0]) {
        throw invariant(
          "CALENDAR_MUTATION_RECONCILE_CONFLICT",
          `attempt ${attempt.id} left ambiguous during reconciliation`,
          { attemptId: attempt.id },
        );
      }
      return rowToAttempt(rows[0]);
    });
  }

  private assertBinding(
    attempt: CalendarMutationAttempt,
    operation: CalendarMutationOperation,
    approvalSha256: string,
  ): void {
    if (
      attempt.operation !== operation ||
      attempt.approvalSha256 !== approvalSha256 ||
      attempt.operationKey !== calendarMutationOperationKey(approvalSha256)
    ) {
      throw invariant(
        "CALENDAR_MUTATION_APPROVAL_CHANGED",
        "approval content differs from the durable mutation attempt",
        {
          requestId: attempt.approvalRequestId,
          attemptId: attempt.id,
          expectedApprovalSha256: attempt.approvalSha256,
          actualApprovalSha256: approvalSha256,
        },
      );
    }
  }

  private async classifyExistingTx(
    tx: TransactionalDb,
    attempt: CalendarMutationAttempt,
  ): Promise<CalendarMutationClaimResult | null> {
    if (attempt.state === "succeeded") {
      return { kind: "already_succeeded", attempt };
    }
    if (attempt.state === "ambiguous") {
      // Rows quarantined before the approval moved with its attempt still
      // sit in executing; move them now so they can be reconciled.
      if (attempt.lastFailure) {
        await quarantineApprovalTx(
          tx,
          String(this.runtime.agentId),
          attempt,
          attempt.lastFailure,
        );
      }
      return { kind: "blocked", reason: "ambiguous", attempt };
    }
    if (attempt.state === "invalidated") {
      return { kind: "invalidated", attempt };
    }
    if (attempt.state !== "executing") return null;
    if (attempt.executorSessionId === this.sessionId) {
      return { kind: "blocked", reason: "in_flight", attempt };
    }

    const failure: CalendarMutationFailure = {
      code: "CALENDAR_MUTATION_ORPHANED_EXECUTION",
      message:
        "A prior executor ended without a durable provider receipt; the provider outcome is unknown.",
      retryable: false,
      details: {
        priorExecutorSessionId: attempt.executorSessionId,
      },
    };
    const rows = await executeRawSqlTx(
      tx,
      `UPDATE app_lifeops.life_calendar_mutation_attempts
          SET state = ${sqlText("ambiguous")},
              last_failure_json = ${sqlJson(failure)},
              updated_at = ${sqlText(new Date().toISOString())}
        WHERE id = ${sqlText(attempt.id)}
          AND agent_id = ${sqlText(this.runtime.agentId)}
          AND state = ${sqlText("executing")}
          AND executor_session_id IS NOT DISTINCT FROM ${sqlText(
            attempt.executorSessionId,
          )}
          AND claim_token IS NOT DISTINCT FROM ${sqlText(attempt.claimToken)}
        RETURNING ${SELECT_COLUMNS}`,
    );
    const ambiguous = rows[0]
      ? rowToAttempt(rows[0])
      : await byApprovalRequestIdTx(
          tx,
          String(this.runtime.agentId),
          attempt.approvalRequestId,
        );
    if (ambiguous?.state !== "ambiguous") {
      throw invariant(
        "CALENDAR_MUTATION_ORPHAN_QUARANTINE_CONFLICT",
        `orphaned attempt ${attempt.id} could not be quarantined`,
        { attemptId: attempt.id },
      );
    }
    await quarantineApprovalTx(
      tx,
      String(this.runtime.agentId),
      ambiguous,
      ambiguous.lastFailure ?? failure,
    );
    return { kind: "blocked", reason: "ambiguous", attempt: ambiguous };
  }
}
