/**
 * Enqueue-side delete-lifecycle hardening for ProvisioningJobService:
 *   - enqueueAgentDeleteOnce.beforeInsert cancels the agent's OTHER pending /
 *     in_progress lifecycle jobs (delete wins; never self-cancels the delete).
 *   - enqueueScheduledBackups only enqueues reachable (bridge_url IS NOT NULL)
 *     running, non-pool agents — idle agents never get an auto snapshot job.
 *   - reEnqueueFailedDeletions re-arms old `deletion_failed` rows by enqueuing a
 *     fresh agent_delete (so a transient unreachable-node delete completes once
 *     the node returns).
 *
 * `dbWrite` is a Proxy that spyOn can't intercept, so this file mock.modules the
 * helpers module with chainable query builders that capture the generated SQL.
 */

import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as realDbHelpers from "../../db/helpers";
import * as realJobsRepository from "../../db/repositories/jobs";
import * as realOutboundUrl from "../security/outbound-url";

// bun's `mock.module` patches the process-global module registry, and this
// file's `afterEach` only resets local capture state — it never reinstalls the
// real modules. Under the batched cloud-unit runner (`--isolate` occasionally
// fails to contain these on a memory-pressured runner) the db/helpers,
// repositories/jobs (`jobsRepository: {}`), and outbound-url doubles otherwise
// bleed into later suites — e.g. provisioning-jobs-execute-dispatch spies on
// the real `jobsRepository.claimPendingJobs`, which becomes undefined. Snapshot
// the real exports now and reinstall them in afterAll so this file's stubs are
// strictly local.
const realDbHelpersExports = { ...realDbHelpers };
const realJobsRepositoryExports = { ...realJobsRepository };
const realOutboundUrlExports = { ...realOutboundUrl };

// ---- captured query state ----
let capturedSelectWhere: SQL | undefined;
let capturedUpdateWhere: SQL | undefined;
let selectRows: unknown[] = [];
let cancelledReturning: Array<{ id: string }> = [];

// select(...).from(...).where(clause).limit(n) -> selectRows
const selectLimit = mock(() => selectRows);
const selectWhere = mock((clause: SQL) => {
  capturedSelectWhere = clause;
  return { limit: selectLimit };
});
const selectFrom = mock(() => ({ where: selectWhere }));
const select = mock(() => ({ from: selectFrom }));

// Transaction tx: only the bits enqueueLifecycleJob + beforeInsert touch.
const txExecute = mock(async () => ({ rows: [] }));
// tx.select().from().where().orderBy().limit() -> [] (no existing job) for the
// reuse lookup; tx.select().from().where().limit() -> [sandbox] for the row.
let txSelectCall = 0;
const txSelect = mock(() => {
  txSelectCall += 1;
  const isSandboxLookup = txSelectCall === 1;
  const rows = isSandboxLookup ? [{ id: "agent", status: "running", updated_at: new Date() }] : [];
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => rows,
  } as Record<string, unknown>;
  return chain;
});
const txUpdateWhere = mock((clause: SQL) => {
  capturedUpdateWhere = clause;
  return { returning: mock(async () => cancelledReturning) };
});
const txUpdateSet = mock(() => ({ where: txUpdateWhere }));
const txUpdate = mock(() => ({ set: txUpdateSet }));
const txInsertValues = mock(() => ({
  returning: mock(async () => [{ id: "job-1", type: "agent_delete", status: "pending", data: {} }]),
}));
const txInsert = mock(() => ({ values: txInsertValues }));
const tx = {
  execute: txExecute,
  select: txSelect,
  update: txUpdate,
  insert: txInsert,
};
const transaction = mock(async (fn: (t: typeof tx) => Promise<unknown>) => {
  txSelectCall = 0;
  return fn(tx);
});

const dbWriteMock = { select, transaction };

// Provide the FULL helpers surface so transitive importers (repositories) keep
// working; only dbWrite is swapped for our capturing mock.
mock.module("../../db/helpers", () => ({
  db: dbWriteMock,
  dbRead: { select, query: {} },
  dbWrite: dbWriteMock,
  getDbConnectionInfo: () => ({}),
  getReadDb: () => dbWriteMock,
  getWriteDb: () => dbWriteMock,
  getDbRoutingInfo: () => ({}),
  logDbRouting: () => {},
  useReadDb: (fn: (d: unknown) => unknown) => fn(dbWriteMock),
  useWriteDb: (fn: (d: unknown) => unknown) => fn(dbWriteMock),
  readQuery: async (_label: string, fn: (d: unknown) => unknown) => fn(dbWriteMock),
  writeQuery: async (_label: string, fn: (d: unknown) => unknown) => fn(dbWriteMock),
  writeTransaction: (fn: (t: typeof tx) => Promise<unknown>) => transaction(fn),
}));

// Stub the outbound-URL guard the enqueue path calls so it can't reach out over
// the network, but keep the module's full export surface intact — `safe-fetch`
// (pulled in transitively) statically imports `isForbiddenIpAddress`,
// `normalizeHostname`, and `resolveSafeOutboundTarget`, and a partial mock would
// break that link with "Export named 'isForbiddenIpAddress' not found".
mock.module("../security/outbound-url", () => ({
  ...realOutboundUrl,
  assertSafeOutboundUrl: mock(async (u: string) => new URL(u)),
}));

// hydrateJob / prepareJobInsertData reach into object-storage offloading; stub
// them to keep the enqueue transaction pure.
mock.module("../../db/repositories/jobs", () => ({
  hydrateJob: async (j: unknown) => j,
  prepareJobInsertData: async (j: unknown) => j,
  jobsRepository: {},
}));

afterEach(() => {
  capturedSelectWhere = undefined;
  capturedUpdateWhere = undefined;
  selectRows = [];
  cancelledReturning = [];
  txSelectCall = 0;
});

afterAll(() => {
  mock.module("../../db/helpers", () => realDbHelpersExports);
  mock.module("../../db/repositories/jobs", () => realJobsRepositoryExports);
  mock.module("../security/outbound-url", () => realOutboundUrlExports);
});

describe("enqueueAgentDeleteOnce.beforeInsert — cancels other pending jobs", () => {
  test("marks the agent's non-delete pending/in_progress jobs cancelled", async () => {
    cancelledReturning = [{ id: "j-restart" }, { id: "j-snapshot" }];
    const orgId = "22222222-2222-4222-8222-222222222222";
    const agentId = "agent";
    const { provisioningJobService } = await import("./provisioning-jobs");

    await provisioningJobService.enqueueAgentDeleteOnce({
      agentId,
      organizationId: orgId,
      userId: "33333333-3333-4333-8333-333333333333",
    });

    // The deletion-pending flip + the cancellation update both ran.
    expect(txUpdate).toHaveBeenCalled();
    // The cancellation set status='cancelled'.
    const cancelSet = txUpdateSet.mock.calls.find(
      (c) => (c[0] as { status?: string })?.status === "cancelled",
    );
    expect(cancelSet).toBeDefined();

    // The cancel WHERE is scoped to this org AND this agent, excludes
    // agent_delete (delete never self-cancels), and only touches
    // pending/in_progress rows (terminal jobs are never reopened). Asserting the
    // scoping prevents a future edit from cancelling sibling agents' or other
    // orgs' jobs.
    if (!capturedUpdateWhere) throw new Error("cancel WHERE clause was not captured");
    const sql = new PgDialect().sqlToQuery(capturedUpdateWhere);
    // Status filter: only pending/in_progress, never a terminal status.
    expect(sql.sql).toContain("pending");
    expect(sql.sql).toContain("in_progress");
    expect(sql.sql).not.toContain("completed");
    expect(sql.sql).not.toContain("cancelled");
    expect(sql.sql).not.toContain("failed");
    // Type filter: excludes agent_delete (the != operator + the bound value).
    expect(sql.sql).toMatch(/<>|!=|not/i);
    expect(sql.params).toContain("agent_delete");
    // Org + agent scoping: both ids are bound parameters of this WHERE clause.
    expect(sql.params).toContain(orgId);
    expect(sql.params).toContain(agentId);
  });
});

describe("enqueueScheduledBackups — only reachable agents", () => {
  test("query requires bridge_url IS NOT NULL (idle agents are never enqueued)", async () => {
    selectRows = []; // nothing due → no enqueue, but we assert the WHERE shape.
    const { provisioningJobService } = await import("./provisioning-jobs");

    const res = await provisioningJobService.enqueueScheduledBackups();
    expect(res).toEqual({ scanned: 0, enqueued: 0 });

    expect(capturedSelectWhere).toBeDefined();
    const sql = new PgDialect().sqlToQuery(capturedSelectWhere as SQL);
    expect(sql.sql).toContain("bridge_url");
    expect(sql.sql.toLowerCase()).toContain("is not null");
  });

  test("a due, reachable agent is enqueued for an auto snapshot", async () => {
    selectRows = [{ id: "agent", organizationId: "org", userId: "user" }];
    const { provisioningJobService } = await import("./provisioning-jobs");
    const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentSnapshotOnce").mockResolvedValue({
      created: true,
      job: { id: "snap-1" },
    } as never);
    try {
      const res = await provisioningJobService.enqueueScheduledBackups();
      expect(res).toEqual({ scanned: 1, enqueued: 1 });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy.mock.calls[0]?.[0]).toMatchObject({
        agentId: "agent",
        snapshotType: "auto",
      });
    } finally {
      enqueueSpy.mockRestore();
    }
  });
});

describe("reEnqueueFailedDeletions — recover stuck deletion_failed rows", () => {
  test("re-enqueues agent_delete for each old deletion_failed row", async () => {
    selectRows = [
      { id: "a1", organizationId: "o1", userId: "u1", errorCount: 1 },
      { id: "a2", organizationId: "o2", userId: "u2", errorCount: 2 },
    ];
    const { provisioningJobService } = await import("./provisioning-jobs");
    const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentDeleteOnce").mockResolvedValue({
      created: true,
      job: { id: "del-1" },
    } as never);
    try {
      const res = await provisioningJobService.reEnqueueFailedDeletions();
      expect(res).toEqual({ scanned: 2, reEnqueued: 2, failed: 0, abandoned: 0 });
      expect(enqueueSpy).toHaveBeenCalledTimes(2);
      expect(enqueueSpy.mock.calls.map((c) => c[0].agentId)).toEqual(["a1", "a2"]);

      // The query recovers BOTH deletion_failed and orphaned deletion_pending
      // rows (the latter guarded by NOT EXISTS an active agent_delete job).
      const sql = new PgDialect().sqlToQuery(capturedSelectWhere as SQL);
      expect(sql.sql).toContain("deletion_failed");
      expect(sql.sql).toContain("deletion_pending");
      expect(sql.params).toContain("agent_delete");
    } finally {
      enqueueSpy.mockRestore();
    }
  });

  test("an enqueue throw on one row is counted, the rest still process", async () => {
    selectRows = [
      { id: "a1", organizationId: "o1", userId: "u1", errorCount: 0 },
      { id: "a2", organizationId: "o2", userId: "u2", errorCount: 0 },
    ];
    const { provisioningJobService } = await import("./provisioning-jobs");
    const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentDeleteOnce").mockImplementation(
      async (p) => {
        if (p.agentId === "a1") throw new Error("node still down");
        return { created: true, job: { id: "del-2" } } as never;
      },
    );
    try {
      const res = await provisioningJobService.reEnqueueFailedDeletions();
      expect(res).toEqual({ scanned: 2, reEnqueued: 1, failed: 1, abandoned: 0 });
    } finally {
      enqueueSpy.mockRestore();
    }
  });

  test("circuit-breaker: a row past the re-enqueue budget is abandoned, not re-armed", async () => {
    // a1 is under the default budget (5) and gets re-enqueued; a2 is at/over the
    // budget and must be skipped + surfaced for ops instead of looping forever.
    selectRows = [
      { id: "a1", organizationId: "o1", userId: "u1", errorCount: 4 },
      { id: "a2", organizationId: "o2", userId: "u2", errorCount: 5 },
    ];
    const { provisioningJobService } = await import("./provisioning-jobs");
    const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentDeleteOnce").mockResolvedValue({
      created: true,
      job: { id: "del-1" },
    } as never);
    try {
      const res = await provisioningJobService.reEnqueueFailedDeletions();
      expect(res).toEqual({ scanned: 2, reEnqueued: 1, failed: 0, abandoned: 1 });
      // Only the under-budget row was re-enqueued; the dead one was not.
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy.mock.calls[0]?.[0].agentId).toBe("a1");
    } finally {
      enqueueSpy.mockRestore();
    }
  });

  test("circuit-breaker threshold is configurable via maxReEnqueues", async () => {
    selectRows = [{ id: "a1", organizationId: "o1", userId: "u1", errorCount: 2 }];
    const { provisioningJobService } = await import("./provisioning-jobs");
    const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentDeleteOnce").mockResolvedValue({
      created: true,
      job: { id: "del-1" },
    } as never);
    try {
      // With a budget of 2, an errorCount of 2 is already abandoned.
      const res = await provisioningJobService.reEnqueueFailedDeletions({ maxReEnqueues: 2 });
      expect(res).toEqual({ scanned: 1, reEnqueued: 0, failed: 0, abandoned: 1 });
      expect(enqueueSpy).not.toHaveBeenCalled();
    } finally {
      enqueueSpy.mockRestore();
    }
  });
});
