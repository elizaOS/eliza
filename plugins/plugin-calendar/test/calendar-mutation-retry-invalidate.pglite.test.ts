/**
 * Verify Calendar attempt and approval settlement with a real local database.
 */
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { RuntimeMigrator } from "@elizaos/plugin-sql";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { approvalRequestTable } from "../../plugin-sql/src/schema/approvalRequests.ts";
import { executeCalendarMutationApproval } from "../src/mutations/execution.ts";
import { CalendarMutationLedger } from "../src/mutations/ledger.ts";
import {
  type CalendarMutationApproval,
  CalendarMutationNotAcceptedError,
  type CalendarMutationPort,
  type CalendarMutationPreflight,
  CalendarMutationPreflightError,
  type CalendarMutationReceipt,
} from "../src/mutations/types.ts";
import { calendarSchema } from "../src/service/index.ts";

const AGENT_ID = "00000000-0000-4000-8000-000000000041";
const REQUEST_ID = "00000000-0000-4000-8000-000000000042";
let pg: PGlite;
let runtime: IAgentRuntime;

async function createTable(table: Parameters<typeof getTableConfig>[0]) {
  const config = getTableConfig(table);
  const dialect = new PgDialect();
  const literal = (v: unknown): string =>
    typeof v === "object" && v && "getSQL" in v
      ? dialect.sqlToQuery(v as Parameters<PgDialect["sqlToQuery"]>[0]).sql
      : typeof v === "object"
        ? `'${JSON.stringify(v)}'::jsonb`
        : typeof v === "string"
          ? `'${v.replaceAll("'", "''")}'`
          : String(v);
  await pg.exec(
    `CREATE TABLE ${config.name} (${config.columns
      .map(
        (c) =>
          `${c.name} ${c.getSQLType()}${c.notNull ? " NOT NULL" : ""}${c.default !== undefined ? ` DEFAULT ${literal(c.default)}` : ""}${c.primary ? " PRIMARY KEY" : ""}`,
      )
      .join(",")})`,
  );
}

const expiresAt = new Date(Date.now() + 86_400_000);
const request = {
  id: REQUEST_ID,
  state: "approved",
  requestedBy: "agent",
  subjectUserId: "owner",
  action: "modify_event",
  payload: {
    action: "modify_event",
    side: "owner",
    grantId: "grant",
    calendarId: "calendar",
    eventId: "event",
    expectedProviderVersion: "etag-1",
    patch: { title: "Moved" },
  },
  channel: "internal",
  reason: "Move the event",
  idempotencyKey: null,
  expiresAt,
} as unknown as CalendarMutationApproval;

const preflight: CalendarMutationPreflight = {
  operation: "modify_event",
  provider: "google",
  sourceId: "grant",
  calendarId: "calendar",
  event: null,
  providerEventId: "event",
  providerVersion: "etag-1",
  idempotencyKey: null,
  recurrenceScope: null,
  cancellationMode: null,
};

const targetChanged = () =>
  new CalendarMutationPreflightError(
    "CALENDAR_MANAGED_TARGET_CHANGED",
    "The Calendar event changed after review",
  );

const acceptedAt = "2026-11-01T12:00:00.000Z";
const receipt: CalendarMutationReceipt = {
  operation: "modify_event",
  provider: "google",
  sourceId: "grant",
  calendarId: "calendar",
  eventId: "calendar-event",
  providerEventId: "event",
  providerVersion: "etag-2",
  readBackAvailable: true,
  accessLevel: "readable",
  recurrenceScope: null,
  cancellationMode: null,
  acceptedAt,
  eventSnapshot: {
    id: "calendar-event",
    externalId: "event",
    agentId: AGENT_ID,
    provider: "google",
    side: "owner",
    calendarId: "calendar",
    title: "Moved",
    description: "Exact reviewed event",
    location: "",
    status: "confirmed",
    startAt: "2026-11-02T12:00:00.000Z",
    endAt: "2026-11-02T13:00:00.000Z",
    isAllDay: false,
    timezone: "UTC",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: { etag: "etag-2" },
    syncedAt: acceptedAt,
    updatedAt: acceptedAt,
    grantId: "grant",
  },
};

const unknownOutcome = {
  code: "CALENDAR_MUTATION_PROVIDER_OUTCOME_UNKNOWN",
  message: "The exact outcome is unknown",
  retryable: false,
};

const replayPort = {
  preflight: vi.fn(async () => preflight),
  execute: vi.fn(async () => receipt),
} satisfies CalendarMutationPort;

async function claim(ledger: CalendarMutationLedger) {
  const result = await ledger.claim(request);
  if (result.kind !== "claimed")
    throw Error(`Unexpected claim: ${result.kind}`);
  return result.attempt;
}

function restartedRuntime(): IAgentRuntime {
  return { ...runtime };
}

async function approvalState(): Promise<string> {
  const rows = await pg.query<{ state: string }>(
    "SELECT state FROM approval_requests WHERE id = $1",
    [REQUEST_ID],
  );
  return rows.rows[0]?.state ?? "missing";
}

async function attemptState(): Promise<string> {
  const rows = await pg.query<{ state: string }>(
    "SELECT state FROM app_lifeops.life_calendar_mutation_attempts WHERE approval_request_id = $1",
    [REQUEST_ID],
  );
  return rows.rows[0]?.state ?? "missing";
}

async function refuseOnce() {
  const refusing: CalendarMutationPort = {
    preflight: async () => preflight,
    execute: async () => {
      throw new CalendarMutationNotAcceptedError(
        "CALENDAR_SYNC_RATE_LIMITED",
        "Calendar change was refused before acceptance.",
      );
    },
  };
  const first = await executeCalendarMutationApproval({
    runtime,
    request,
    port: refusing,
  });
  expect(first.kind).toBe("retryable");
  expect(await attemptState()).toBe("failed_retryable");
}

const changedPort: CalendarMutationPort = {
  preflight: async () => {
    throw targetChanged();
  },
  execute: async () => {
    throw Error("must not dispatch");
  },
};

beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg);
  await new RuntimeMigrator(db).migrate(
    "@elizaos/plugin-calendar",
    calendarSchema,
  );
  await createTable(approvalRequestTable);
  runtime = { agentId: AGENT_ID, adapter: { db }, db } as never;
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  replayPort.preflight.mockClear();
  replayPort.execute.mockClear();
  await pg.exec(
    "DELETE FROM app_lifeops.life_calendar_mutation_attempts; DELETE FROM approval_requests;",
  );
  await pg.query(
    `INSERT INTO approval_requests (
       id, agent_id, state, requested_by, subject_user_id, action, payload,
       channel, reason, expires_at, created_at, updated_at
     ) VALUES ($1, $2, 'approved', 'agent', 'owner', 'modify_event', $3,
       'internal', 'Move the event', $4, now(), now())`,
    [REQUEST_ID, AGENT_ID, JSON.stringify(request.payload), expiresAt],
  );
});

it("ends a refused approval when the retry finds the event changed", async () => {
  await refuseOnce();
  expect(await approvalState()).toBe("retryable");

  const retry = await executeCalendarMutationApproval({
    runtime,
    request,
    port: changedPort,
  });
  expect(retry).toMatchObject({
    kind: "invalidated",
    failure: { code: "CALENDAR_MANAGED_TARGET_CHANGED" },
  });
  expect(await attemptState()).toBe("invalidated");
  expect(await approvalState()).toBe("expired");
});

it("ends a refused approval left in executing by older rows", async () => {
  await refuseOnce();
  await pg.query(
    "UPDATE approval_requests SET state = 'executing' WHERE id = $1",
    [REQUEST_ID],
  );

  const retry = await executeCalendarMutationApproval({
    runtime,
    request,
    port: changedPort,
  });
  expect(retry.kind).toBe("invalidated");
  expect(await attemptState()).toBe("invalidated");
  expect(await approvalState()).toBe("expired");
});

it("does not invalidate an attempt that is still executing", async () => {
  await refuseOnce();
  await pg.exec(
    "UPDATE app_lifeops.life_calendar_mutation_attempts SET state = 'executing'; UPDATE approval_requests SET state = 'executing';",
  );

  const retry = await executeCalendarMutationApproval({
    runtime,
    request,
    port: changedPort,
  });
  // An orphaned executing attempt may have reached the provider, so it is
  // quarantined for reconciliation, never invalidated.
  expect(retry.kind).toBe("blocked");
  expect(await attemptState()).not.toBe("invalidated");
  expect(await approvalState()).not.toBe("expired");
});

it("gives one concurrent claimant the exact receipt and replays it after restart", async () => {
  const ledger = new CalendarMutationLedger(runtime);
  const results = await Promise.all([
    ledger.claim(request),
    new CalendarMutationLedger(runtime).claim(request),
  ]);
  const claimed = results.find((result) => result.kind === "claimed");
  if (!claimed) throw Error("Neither caller claimed the attempt");
  expect(results.filter((result) => result !== claimed)).toMatchObject([
    { kind: "blocked", reason: "in_flight" },
  ]);
  expect(claimed.attempt.attemptCount).toBe(1);
  expect(await approvalState()).toBe("executing");

  await expect(
    ledger.recordSuccess(claimed.attempt, receipt),
  ).resolves.toMatchObject({ state: "succeeded", receipt });
  expect(await approvalState()).toBe("done");
  const restarted = restartedRuntime();
  const replay = await executeCalendarMutationApproval({
    runtime: restarted,
    request,
    port: replayPort,
  });
  if (replay.kind !== "succeeded") throw Error("Expected a receipt replay");
  expect(replay.duplicateSuppressed).toBe(true);
  expect(replay.receipt).toEqual(receipt);
  expect(replayPort.preflight).not.toHaveBeenCalled();
  expect(replayPort.execute).not.toHaveBeenCalled();
});

it("keeps an orphan blocked after owner confirmation without a receipt", async () => {
  const ledger = new CalendarMutationLedger(runtime);
  const attempt = await claim(ledger);
  const restarted = restartedRuntime();
  const recovery = new CalendarMutationLedger(restarted);
  await expect(recovery.inspect(request)).resolves.toMatchObject({
    kind: "blocked",
    reason: "ambiguous",
    attempt: {
      id: attempt.id,
      lastFailure: { code: "CALENDAR_MUTATION_ORPHANED_EXECUTION" },
    },
  });
  expect(await approvalState()).toBe("reconciliation_required");
  await expect(ledger.recordSuccess(attempt, receipt)).resolves.toMatchObject({
    state: "ambiguous",
    receipt: null,
  });
  await expect(
    recovery.reconcile(REQUEST_ID, {
      outcome: "applied",
      receipt: null,
      reconciledBy: "owner",
      reason: "Owner saw the change",
    }),
  ).resolves.toMatchObject({ state: "ambiguous", receipt: null });
  expect(await approvalState()).toBe("done");
  await expect(
    executeCalendarMutationApproval({
      runtime: restarted,
      request,
      port: replayPort,
    }),
  ).resolves.toMatchObject({
    kind: "blocked",
    reason: "ambiguous",
    attempt: { attemptCount: 1, receipt: null },
  });
  expect(replayPort.preflight).not.toHaveBeenCalled();
  expect(replayPort.execute).not.toHaveBeenCalled();
});

it("reconciles only the matching operation and persists the exact receipt in both rows", async () => {
  const ledger = new CalendarMutationLedger(runtime);
  const attempt = await claim(ledger);
  await ledger.recordAmbiguous(attempt, unknownOutcome);
  const evidence = {
    outcome: "applied",
    receipt,
    reconciledBy: "owner",
    reason: "Readback confirms the exact change",
  } as const;
  await expect(
    ledger.reconcile(REQUEST_ID, {
      ...evidence,
      receipt: { ...receipt, operation: "cancel_event" },
    }),
  ).rejects.toMatchObject({
    code: "CALENDAR_MUTATION_RECONCILE_RECEIPT_INVALID",
  });
  expect(await approvalState()).toBe("reconciliation_required");
  await expect(ledger.byApprovalRequestId(REQUEST_ID)).resolves.toMatchObject({
    state: "ambiguous",
    receipt: null,
  });
  const reconciled = await ledger.reconcile(REQUEST_ID, evidence);
  expect(reconciled).toMatchObject({
    state: "succeeded",
  });
  expect(reconciled.receipt).toEqual(receipt);
  const approval = await pg.query(
    "SELECT state, execution_attempt_id, provider_receipt FROM approval_requests WHERE id = $1",
    [REQUEST_ID],
  );
  expect(approval.rows).toEqual([
    {
      state: "done",
      execution_attempt_id: attempt.id,
      provider_receipt: receipt,
    },
  ]);
  await expect(
    new CalendarMutationLedger(restartedRuntime()).inspect(request),
  ).resolves.toMatchObject({
    kind: "already_succeeded",
    attempt: { id: attempt.id, receipt },
  });
});

it("allows a reconciled non-delivery to retry and rejects settlement with the old token", async () => {
  const ledger = new CalendarMutationLedger(runtime);
  const first = await claim(ledger);
  await ledger.recordAmbiguous(first, unknownOutcome);
  await expect(
    ledger.reconcile(REQUEST_ID, {
      outcome: "not_applied",
      reconciledBy: "owner",
      reason: "Owner confirmed the event did not change",
    }),
  ).resolves.toMatchObject({
    state: "failed_retryable",
    claimToken: null,
    receipt: null,
  });
  expect(await approvalState()).toBe("retryable");
  const retry = await claim(ledger);
  expect(retry).toMatchObject({
    id: first.id,
    operationKey: first.operationKey,
    executorSessionId: first.executorSessionId,
    attemptCount: 2,
  });
  expect(retry.claimToken).not.toBe(first.claimToken);
  await expect(ledger.recordSuccess(first, receipt)).rejects.toMatchObject({
    code: "CALENDAR_MUTATION_RECEIPT_PERSIST_CONFLICT",
  });
  await expect(ledger.byApprovalRequestId(REQUEST_ID)).resolves.toMatchObject({
    state: "executing",
    claimToken: retry.claimToken,
    receipt: null,
  });
  expect(await approvalState()).toBe("executing");
  await expect(ledger.recordSuccess(retry, receipt)).resolves.toMatchObject({
    state: "succeeded",
    receipt,
  });
  expect(await approvalState()).toBe("done");
});
