/**
 * Live-slot accounting coverage for Docker node allocation counts. Terminal
 * agent sandbox rows must not inflate allocated_count, or the autoscaler reads
 * bare-metal robots as full and bills new Hetzner-cloud nodes instead (#15378).
 */
// These suites mock `db/helpers` with a partial `dbWrite` (no `execute`), so the
// self-healing DDL guard cannot run here. Skipping it is the house pattern for
// mocked-database suites; the guard itself is covered by the PGlite tests.
const PRIOR_SKIP_ENSURE = process.env.SKIP_AGENT_SANDBOX_ENSURE;
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const capturedWheres: SQL[] = [];
const capturedSelections: Array<Record<string, SQL>> = [];

// dbWrite.select(fields).from().where(clause) captures each statement and
// returns one synthetic aggregate row, so the query builder runs end-to-end
// without a live DB.
const where = mock((clause: SQL, fields: Record<string, SQL>) => {
  capturedWheres.push(clause);
  if ("relation" in fields) return [{ relation: undefined }];
  return [Object.fromEntries(Object.keys(fields).map((key) => [key, 1]))];
});
const select = mock((fields: Record<string, SQL>) => {
  capturedSelections.push(fields);
  return {
    from: mock(() => ({ where: (clause: SQL) => where(clause, fields) })),
  };
});
const readSelect = mock(() => {
  throw new Error("capacity authority must not read from the replica");
});

// Replace the whole helpers module: dbRead captures the query, the rest are
// stubs so every static import in the transitive chain still resolves.
mock.module("../../db/helpers", () => ({
  dbRead: { select: readSelect },
  dbWrite: {
    select,
    update: mock(() => ({ set: mock(() => ({ where: mock(() => []) })) })),
  },
  useReadDb: mock(),
  useWriteDb: mock(),
  readQuery: mock(),
  writeQuery: mock(),
  writeTransaction: mock(),
  getReadDb: mock(),
  getWriteDb: mock(),
  logDbRouting: mock(),
  getDbRoutingInfo: mock(() => ({})),
}));

const { countAllocatedWorkloadsOnNode } = await import("./docker-node-workloads");

function renderParams(clause: SQL): string[] {
  const { params } = new PgDialect().sqlToQuery(clause);
  return params.map((p) => String(p));
}

function renderSelectionParams(selection: Record<string, SQL>): string[] {
  return Object.values(selection).flatMap(renderParams);
}

describe("countAllocatedWorkloadsOnNode — live-slot accounting (#15378)", () => {
  beforeEach(() => {
    capturedWheres.length = 0;
    capturedSelections.length = 0;
    where.mockClear();
    select.mockClear();
    readSelect.mockClear();
  });

  test("the agent_sandboxes filter recognizes every terminal status before ownership override", async () => {
    await countAllocatedWorkloadsOnNode("node-under-test");

    const agentParams = capturedSelections
      .map(renderSelectionParams)
      .find((params) => params.includes("sleeping"));

    expect(agentParams).toBeDefined();
    // Regression: the status vocabulary previously omitted sleeping and
    // deletion_failed. The query's ownership branch may still count a terminal
    // deletion row when its container has not been proven stopped.
    for (const terminal of ["stopped", "error", "sleeping", "deletion_failed"]) {
      expect(agentParams).toContain(terminal);
    }
    // disconnected is NON-terminal (container up but unreachable) — it still
    // occupies the slot and must NOT be excluded from the count.
    expect(agentParams).not.toContain("disconnected");
    expect(agentParams).not.toContain("running");
  });

  test("sums container + agent counts (one row each here) into total live slots", async () => {
    const total = await countAllocatedWorkloadsOnNode("node-under-test");
    // One rolling-deploy relation probe, then one aggregate statement for all
    // four workload ledgers.
    expect(where).toHaveBeenCalledTimes(2);
    expect(readSelect).not.toHaveBeenCalled();
    expect(total).toBe(4);
  });

  test("reads all present workload ledgers in one aggregate statement snapshot", async () => {
    await countAllocatedWorkloadsOnNode("node-under-test");

    expect(select).toHaveBeenCalledTimes(2);
    expect(Object.keys(capturedSelections[1] ?? {})).toEqual([
      "containerCount",
      "agentCount",
      "replacementCleanupCount",
      "exactRestoreReplacementCount",
    ]);
  });

  test("counts a durable replacement reservation as its own live slot", async () => {
    await countAllocatedWorkloadsOnNode("replacement-node");

    const rendered = capturedSelections.map(renderSelectionParams);
    const aggregateParams = rendered.find((params) => params.includes("replacement-node"));
    expect(aggregateParams?.filter((param) => param === "replacement-node")).toHaveLength(4);
  });

  test("counts only active exact-restore replacement reservation states", async () => {
    await countAllocatedWorkloadsOnNode("replacement-node");

    const replacementParams = capturedSelections
      .map(renderSelectionParams)
      .find((params) => params.includes("in_flight_unresolved"));
    expect(replacementParams).toBeDefined();
    for (const state of ["in_flight_unresolved", "cleanup_in_progress", "provider_succeeded"]) {
      expect(replacementParams).toContain(state);
    }
    expect(replacementParams).not.toContain("lifecycle_committed");
    expect(replacementParams).not.toContain("cleanup_proven");
  });
});

// bun shares one process across files without --isolate, so an unrestored env
// override here would silently disable the ensure guard for whatever suite runs
// next. Restore exactly what was there before.
afterAll(() => {
  if (PRIOR_SKIP_ENSURE === undefined) delete process.env.SKIP_AGENT_SANDBOX_ENSURE;
  else process.env.SKIP_AGENT_SANDBOX_ENSURE = PRIOR_SKIP_ENSURE;
});
