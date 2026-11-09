/**
 * A refused managed Calendar write leaves the approval retryable. When the
 * owner retries and preflight then fails for good (the event changed), the
 * ledger must end the approval instead of wedging it.
 */
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { RuntimeMigrator } from "@elizaos/plugin-sql";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { approvalRequestTable } from "../../plugin-sql/src/schema/approvalRequests.ts";
import { executeCalendarMutationApproval } from "../src/mutations/execution.ts";
import {
  type CalendarMutationApproval,
  CalendarMutationNotAcceptedError,
  type CalendarMutationPort,
  type CalendarMutationPreflight,
  CalendarMutationPreflightError,
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

const expiresAt = new Date("2026-12-01T00:00:00.000Z");
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
