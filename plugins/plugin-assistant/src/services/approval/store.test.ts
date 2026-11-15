import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { drizzle } from "drizzle-orm/pglite";
import { expect, it } from "vitest";
import { PgApprovalQueue } from "./store.ts";

it("expires lapsed pending rows and approvals that were never claimed", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE approval_requests (
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
    )`);
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
