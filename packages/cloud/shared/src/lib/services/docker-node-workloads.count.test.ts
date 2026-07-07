/**
 * Live-slot accounting coverage for Docker node allocation counts. Terminal
 * agent sandbox rows must not inflate allocated_count, or the autoscaler reads
 * bare-metal robots as full and bills new Hetzner-cloud nodes instead (#15378).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const capturedWheres: SQL[] = [];

// dbRead.select().from().where(clause) captures each clause and resolves to a
// single count row, so the query builder runs end-to-end without a live DB.
const where = mock((clause: SQL) => {
  capturedWheres.push(clause);
  return [{ count: 1 }];
});
const from = mock(() => ({ where }));
const select = mock(() => ({ from }));

// Replace the whole helpers module: dbRead captures the query, the rest are
// stubs so every static import in the transitive chain still resolves.
mock.module("../../db/helpers", () => ({
  dbRead: { select },
  dbWrite: { update: mock(() => ({ set: mock(() => ({ where: mock(() => []) })) })) },
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

describe("countAllocatedWorkloadsOnNode — live-slot accounting (#15378)", () => {
  beforeEach(() => {
    capturedWheres.length = 0;
    where.mockClear();
  });

  test("the agent_sandboxes filter excludes every terminal status, not just stopped/error", async () => {
    await countAllocatedWorkloadsOnNode("node-under-test");

    // Two queries run (containers + agent_sandboxes); the agent one is the
    // clause whose params carry the sandbox terminal-status vocab.
    const agentParams = capturedWheres
      .map(renderParams)
      .find((params) => params.includes("sleeping"));

    expect(agentParams).toBeDefined();
    // Regression: the previous filter only excluded stopped/error, so sleeping
    // and deletion_failed sandboxes kept holding phantom slots.
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
    expect(where).toHaveBeenCalledTimes(2);
    expect(total).toBe(2);
  });
});
