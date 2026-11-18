import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { drizzle } from "drizzle-orm/pglite";
import { expect, it } from "vitest";
import { PgApprovalQueue } from "./store.ts";

const TABLE = `CREATE TABLE approval_requests (
      id text, state text, requested_by text, subject_user_id text,
      action text, payload jsonb, channel text, reason text,
      idempotency_key text, expires_at timestamptz, resolved_at timestamptz,
      resolved_by text, resolution_reason text, execution_attempt_id text,
      execution_provider text, provider_idempotency_key text,
      execution_claimed_at timestamptz, dispatch_started_at timestamptz,
      provider_receipt jsonb, execution_error text,
      reconciliation_resolved_at timestamptz, reconciliation_resolved_by text,
      reconciliation_reason text, created_at timestamptz, updated_at timestamptz,
      agent_id text
    )`;

it("expires lapsed pending rows and approvals that were never claimed", async () => {
  const db = new PGlite();
  try {
    await db.exec(TABLE);
    for (const [id, state, expires, attempt] of [
      ["lapsed-pending", "pending", "2026-10-25T00:00:00Z", null],
      ["lapsed-approved", "approved", "2026-10-25T00:00:00Z", null],
      ["claimed-approved", "approved", "2026-10-25T00:00:00Z", "attempt"],
      ["current-approved", "approved", "2026-10-25T02:00:00Z", null],
    ])
      await db.query(
        `INSERT INTO approval_requests
        (id,state,requested_by,subject_user_id,action,payload,channel,reason,
         expires_at,execution_attempt_id,created_at,updated_at,agent_id)
        VALUES ($1,$2,'agent','account','send_message','{}'::jsonb,'sms','review',
         $3,$4,'2026-10-24T23:50:00Z','2026-10-24T23:50:00Z','agent')`,
        [id, state, expires, attempt],
      );
    const runtime = {
      agentId: "agent",
      adapter: { db: drizzle(db) },
      getService: () => null,
    } as unknown as IAgentRuntime;
    const queue = new PgApprovalQueue(runtime, { agentId: "agent" });
    const expired = await queue.purgeExpired(new Date("2026-10-25T01:00:00Z"));
    expect([...expired].sort()).toEqual(["lapsed-approved", "lapsed-pending"]);
    expect(
      (
        await db.query<{ id: string; state: string }>(
          "SELECT id, state FROM approval_requests ORDER BY id",
        )
      ).rows,
    ).toEqual([
      { id: "claimed-approved", state: "approved" },
      { id: "current-approved", state: "approved" },
      { id: "lapsed-approved", state: "expired" },
      { id: "lapsed-pending", state: "expired" },
    ]);
  } finally {
    await db.close();
  }
});

// v610: a Files review that lapsed at 04:21 was still listed as pending hours
// later, because expiry ran only when something tried to transition it.
it("closes lapsed reviews in its own scope before listing pending work", async () => {
  const db = new PGlite();
  try {
    await db.exec(TABLE);
    // The lapsed v610 Files review's payload.
    const FILES_REVIEW = {
      action: "device_action",
      version: 1,
      operation: { kind: "document", type: "files_filter" },
      enrollmentId: "b3b0919e-0396-45e3-aa06-4858e9d3d79e",
      installationId: "89eb7cbb-09c8-4a4e-a322-090b8e7375bb",
    };
    const past = "2026-10-25T00:00:00Z",
      future = "2099-01-01T00:00:00Z";
    for (const [id, state, subject, action, expires, attempt] of [
      ["lapsed-pending", "pending", "owner", "device_action", past, null],
      ["lapsed-approved", "approved", "owner", "device_action", past, null],
      ["lapsed-camera", "pending", "owner", "device_action", past, null],
      ["claimed-approved", "approved", "owner", "device_action", past, "a"],
      ["current-pending", "pending", "owner", "device_action", future, null],
      ["other-subject", "pending", "guest", "device_action", past, null],
      ["other-action", "pending", "owner", "send_message", past, null],
    ])
      await db.query(
        `INSERT INTO approval_requests
        (id,state,requested_by,subject_user_id,action,payload,channel,reason,
         expires_at,execution_attempt_id,execution_provider,
         provider_idempotency_key,execution_claimed_at,created_at,updated_at,
         agent_id)
        VALUES ($1,$2,'agent',$3,$4,$7::jsonb,'phone','review',
         $5,$6,CASE WHEN $6::text IS NULL THEN NULL ELSE 'device:enrollment' END,
         CASE WHEN $6::text IS NULL THEN NULL ELSE $1 END,
         CASE WHEN $6::text IS NULL THEN NULL ELSE '2026-10-24T23:55:00Z'::timestamptz END,
         '2026-10-24T23:50:00Z','2026-10-24T23:50:00Z','agent')`,
        [
          id,
          state,
          subject,
          action,
          expires,
          attempt,
          JSON.stringify(
            id === "lapsed-camera"
              ? { ...FILES_REVIEW, operation: { type: "camera_capture_photo" } }
              : FILES_REVIEW,
          ),
        ],
      );
    const read: string[] = [];
    const runtime = {
      agentId: "agent",
      adapter: { db: drizzle(db) },
      getService: (type: string) =>
        type === "notification"
          ? {
              notify: async () => undefined,
              markReadByGroupKey: async (key: string) => void read.push(key),
            }
          : null,
    } as unknown as IAgentRuntime;
    const queue = new PgApprovalQueue(runtime, { agentId: "agent" });
    const states = async () =>
      Object.fromEntries(
        (
          await db.query<{ id: string; state: string }>(
            "SELECT id, state FROM approval_requests ORDER BY id",
          )
        ).rows.map((row) => [row.id, row.state]),
      );
    const before = await states();
    // A listing that cannot return pending or approved rows writes nothing.
    await queue.list({
      subjectUserId: "owner",
      state: null,
      states: ["done", "rejected", "expired"],
      action: "device_action",
    });
    expect(await states()).toEqual(before);

    await queue.list({
      subjectUserId: "owner",
      state: "pending",
      action: "device_action",
      operationTypes: [],
    });
    expect(await states()).toEqual(before);
    expect(read).toEqual([]);

    const pending = await queue.list({
      subjectUserId: "owner",
      state: "pending",
      action: "device_action",
      operationTypes: ["files_filter"],
    });
    expect(pending.map((request) => request.id)).toEqual(["current-pending"]);
    // Only the listed state is closed.
    expect(await states()).toEqual({ ...before, "lapsed-pending": "expired" });
    expect(read).toEqual(["approval:lapsed-pending"]);
    // The open-work listing the phone reads now reports the lapse as expired.
    const open = await queue.list({
      subjectUserId: "owner",
      state: null,
      states: ["pending", "approved", "executing"],
      action: "device_action",
    });
    expect(open.map((request) => [request.id, request.state]).sort()).toEqual([
      ["claimed-approved", "approved"],
      ["current-pending", "pending"],
    ]);
    // An approval that was never claimed lapsed with it; other subjects and
    // actions are left to their own listings.
    expect(await states()).toEqual({
      ...before,
      "lapsed-pending": "expired",
      "lapsed-approved": "expired",
      "lapsed-camera": "expired",
    });
    expect(read.sort()).toEqual([
      "approval:lapsed-approved",
      "approval:lapsed-camera",
      "approval:lapsed-pending",
    ]);
  } finally {
    await db.close();
  }
});
