import { describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

let capturedWhere: SQL | undefined;
let capturedSet: Record<string, unknown> | undefined;

const returning = mock(() => [
  {
    id: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
    status: "provisioning",
  },
]);
const where = mock((clause: SQL) => {
  capturedWhere = clause;
  return { returning };
});
const set = mock((values: Record<string, unknown>) => {
  capturedSet = values;
  return { where };
});
const update = mock(() => ({ set }));
const ensureAgentSandboxSchema = mock(async () => {});

mock.module("../helpers", () => ({
  dbRead: {},
  dbWrite: { update },
}));

mock.module("../ensure-agent-sandbox-schema", () => ({
  ensureAgentSandboxSchema,
}));

describe("AgentSandboxesRepository", () => {
  test("allows sleeping agents to take the provisioning lock for wake", async () => {
    capturedWhere = undefined;

    const { AgentSandboxesRepository } = await import("./agent-sandboxes");

    await new AgentSandboxesRepository().trySetProvisioning("e06bb509-6c52-4c33-a9f7-66addc43e8c8");

    expect(ensureAgentSandboxSchema).toHaveBeenCalled();
    if (!capturedWhere) throw new Error("trySetProvisioning did not build a where clause");
    expect(new PgDialect().sqlToQuery(capturedWhere).sql).toContain("'sleeping'");
  });

  test("marks only orphaned user-owned pending rows with no provision job as error", async () => {
    capturedWhere = undefined;
    capturedSet = undefined;

    const { AgentSandboxesRepository } = await import("./agent-sandboxes");

    const cutoff = new Date("2026-06-14T00:00:00.000Z");
    await new AgentSandboxesRepository().markOrphanedPendingWithoutJobAsError(cutoff);

    expect(ensureAgentSandboxSchema).toHaveBeenCalled();
    if (!capturedWhere)
      throw new Error("markOrphanedPendingWithoutJobAsError did not build a where clause");
    const sql = new PgDialect().sqlToQuery(capturedWhere).sql.toLowerCase();
    // Only `pending` rows are targeted...
    expect(sql).toContain("'pending'");
    // ...that are user-owned (warm-pool rows carry a pool_status, so skip them)...
    expect(sql).toContain("pool_status");
    expect(sql).toContain("is null");
    // ...aged past the cutoff (keyed on created_at, not updated_at)...
    expect(sql).toContain("created_at");
    // ...and have NO live agent_provision job.
    expect(sql).toContain("not exists");
    expect(sql).toContain("agent_provision");
    // The job predicate is load-bearing: only LIVE jobs ('pending'/'in_progress')
    // count, so a row whose only agent_provision job is completed/error is still
    // reclaimed. Assert the live-state filter is present and dead states are not.
    expect(sql).toContain("'pending', 'in_progress'");
    expect(sql).not.toContain("'completed'");
    expect(sql).not.toContain("'error'");

    // It MARKS ERROR (it never re-enqueues) with a clear, retry-able message.
    expect(capturedSet?.status).toBe("error");
    expect(String(capturedSet?.error_message)).toContain("no agent_provision job was enqueued");
    // updated_at is bumped so the row no longer matches the cron on the next tick.
    expect(capturedSet?.updated_at instanceof Date).toBe(true);
  });
});
