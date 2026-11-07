import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { drizzle } from "drizzle-orm/pglite";
import { expect, it } from "vitest";
import { readApprovalRequestsForOriginalSources } from "./store.ts";

it("reads only exact agent, requester, proposal and original-message pairs from SQL", async () => {
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
    for (const [id, agent, requester, message] of [
      ["allowed", "agent", "agent", "message"],
      ["other-agent", "other", "agent", "message"],
      ["other-requester", "agent", "other", "message"],
      ["other-message", "agent", "agent", "another-message"],
    ]) {
      const payload = {
        action: "device_action",
        version: 1,
        installationId: "installation",
        enrollmentId: "enrollment",
        requestMessageId: message,
        operation: { type: "browser_navigate", url: "https://example.test/" },
      };
      await db.query(
        `INSERT INTO approval_requests
        (id,state,requested_by,subject_user_id,action,payload,channel,reason,idempotency_key,
         expires_at,created_at,updated_at,agent_id)
        VALUES ($1,'rejected',$2,'account','device_action',$3::jsonb,'phone','review','key',
         '2026-10-25T00:00:00Z','2026-10-24T00:00:00Z','2026-10-24T00:10:00Z',$4)`,
        [id, requester, JSON.stringify(payload), agent],
      );
    }
    const runtime = {
      agentId: "agent",
      adapter: { db: drizzle(db) },
    } as unknown as IAgentRuntime;
    const rows = await readApprovalRequestsForOriginalSources(
      runtime,
      ["allowed", "other-agent", "other-requester", "other-message"].map(
        (proposalId) => ({ proposalId, requestMessageId: "message" }),
      ),
    );
    expect(rows.map((row) => row.id)).toEqual(["allowed"]);
    expect(rows[0].state).toBe("rejected");
    expect(rows[0].payload).toMatchObject({ requestMessageId: "message" });
    expect(
      (await db.query("SELECT count(*)::int AS count FROM approval_requests"))
        .rows,
    ).toEqual([{ count: 4 }]);
  } finally {
    await db.close();
  }
});
