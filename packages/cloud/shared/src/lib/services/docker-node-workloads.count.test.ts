/**
 * Live-slot accounting coverage for Docker node allocation counts. Terminal
 * agent sandbox rows must not inflate allocated_count, or the autoscaler reads
 * bare-metal robots as full and bills new Hetzner-cloud nodes instead (#15378).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const capturedQueries: SQL[] = [];
const capturedPrimaryQueries: SQL[] = [];

// Production uses one statement so every handoff is observed in one snapshot.
const execute = mock((query: SQL) => {
  capturedQueries.push(query);
  return { rows: [{ count: 5 }] };
});
const primaryExecute = mock((query: SQL) => {
  capturedPrimaryQueries.push(query);
  return { rows: [{ count: 6 }] };
});
const primaryTransaction = mock(async (_callback: unknown) => null);

// Replace the whole helpers module: dbRead captures the query, the rest are
// stubs so every static import in the transitive chain still resolves.
mock.module("../../db/helpers", () => ({
  dbRead: { execute },
  dbWrite: {
    execute: primaryExecute,
    transaction: primaryTransaction,
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

const {
  countAllocatedWorkloadsOnNode,
  countRetainedWorkloadsOnNode,
  reconcileAllocatedWorkloadsOnNode,
} = await import("./docker-node-workloads");

function renderQuery(query: SQL): { sql: string; params: string[] } {
  const rendered = new PgDialect().sqlToQuery(query);
  return { sql: rendered.sql, params: rendered.params.map((param) => String(param)) };
}

describe("countAllocatedWorkloadsOnNode — live-slot accounting (#15378)", () => {
  beforeEach(() => {
    capturedQueries.length = 0;
    capturedPrimaryQueries.length = 0;
    execute.mockClear();
    primaryExecute.mockClear();
    primaryTransaction.mockReset();
    primaryTransaction.mockImplementation(async () => null);
  });

  test("the agent_sandboxes filter recognizes every terminal status before ownership override", async () => {
    await countAllocatedWorkloadsOnNode("node-under-test");

    const agentParams = renderQuery(capturedQueries[0]!).params;

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

  test("derives every owner class in one database statement", async () => {
    const total = await countAllocatedWorkloadsOnNode("node-under-test");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(total).toBe(5);
  });

  test("uses durable app slot markers before the legacy status fallback", async () => {
    await countAllocatedWorkloadsOnNode("node-under-test");

    const rendered = renderQuery(capturedQueries[0]!).sql;
    expect(rendered).toContain("slotClaimedAt");
    expect(rendered).toContain("slotReleasedAt");
    expect(rendered).toContain("jsonb_exists");
  });

  test("counts only reserved restore and replacement ledger owners", async () => {
    await countAllocatedWorkloadsOnNode("replacement-node");

    const rendered = renderQuery(capturedQueries[0]!);
    expect(rendered.params.filter((param) => param === "replacement-node")).toHaveLength(6);
    expect(rendered.sql).toContain('"agent_backup_restore_operations"');
    expect(rendered.sql).toContain('"agent_sandbox_replacement_attempts"');
    // Two owner subqueries count reserved ledgers; the cleanup subquery also
    // checks for an exact reserved replacement attempt so it cannot double-count
    // the same physical placement during the handoff window.
    expect(rendered.sql.match(/capacity_state/g)).toHaveLength(3);
    expect(rendered.sql.match(/= 'reserved'/g)).toHaveLength(3);
    expect(rendered.sql).not.toContain("handed_off");
    expect(rendered.sql).not.toContain("released");
  });

  test("fails closed once when migration 0315 ownership columns are missing", async () => {
    const driverError = Object.assign(new Error('column "capacity_state" does not exist'), {
      code: "42703",
    });
    const missingColumn = new Error("Failed query", { cause: driverError });
    execute.mockImplementationOnce(() => {
      throw missingColumn;
    });

    await expect(countAllocatedWorkloadsOnNode("pre-0315-node")).rejects.toMatchObject({
      code: "DOCKER_NODE_CAPACITY_OWNERSHIP_MIGRATION_REQUIRED",
      context: {
        nodeId: "pre-0315-node",
        migration: "0315_agent_restore_capacity_ownership",
      },
      cause: missingColumn,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(primaryExecute).not.toHaveBeenCalled();
  });

  test("reads retained and reserved owners from the primary", async () => {
    const total = await countRetainedWorkloadsOnNode("draining-node");

    expect(total).toBe(6);
    expect(primaryExecute).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    const rendered = renderQuery(capturedPrimaryQueries[0]!).sql;
    expect(rendered).toContain('"containers"."volume_path" IS NOT NULL');
    expect(rendered).not.toContain('"containers"."hcloud_volume_id"');
    expect(rendered).toContain("slotClaimedAt");
    expect(rendered).toContain("slotReleasedAt");
    expect(rendered).toContain('"agent_sandboxes"."deletion_allocation_counted" IS TRUE');
  });

  test("fails a pre-0315 retained count closed on the primary without retrying", async () => {
    const missingColumn = Object.assign(new Error('column "capacity_state" does not exist'), {
      code: "42703",
    });
    primaryExecute.mockImplementationOnce(() => {
      throw missingColumn;
    });

    await expect(countRetainedWorkloadsOnNode("pre-0315-drain-node")).rejects.toMatchObject({
      code: "DOCKER_NODE_CAPACITY_OWNERSHIP_MIGRATION_REQUIRED",
      context: {
        nodeId: "pre-0315-drain-node",
        migration: "0315_agent_restore_capacity_ownership",
      },
      cause: missingColumn,
    });
    expect(primaryExecute).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  test("fails reconciliation closed with the typed migration error", async () => {
    const missingColumn = Object.assign(new Error('column "capacity_state" does not exist'), {
      code: "42703",
    });
    primaryTransaction.mockImplementationOnce(async () => {
      throw missingColumn;
    });

    await expect(reconcileAllocatedWorkloadsOnNode("pre-0315-sync-node")).rejects.toMatchObject({
      code: "DOCKER_NODE_CAPACITY_OWNERSHIP_MIGRATION_REQUIRED",
      context: {
        nodeId: "pre-0315-sync-node",
        migration: "0315_agent_restore_capacity_ownership",
      },
      cause: missingColumn,
    });
    expect(primaryTransaction).toHaveBeenCalledTimes(1);
  });

  test("sync performs the recount and write under the node-locking helper", () => {
    const managerSource = readFileSync(join(import.meta.dir, "docker-node-manager.ts"), "utf8");
    const workloadsSource = readFileSync(join(import.meta.dir, "docker-node-workloads.ts"), "utf8");
    const syncSource = managerSource.slice(
      managerSource.indexOf("async syncAllocatedCounts"),
      managerSource.indexOf("async prePullAgentImageOnAvailableNodes"),
    );
    const reconcileSource = workloadsSource.slice(
      workloadsSource.indexOf("export async function reconcileAllocatedWorkloadsOnNode"),
      workloadsSource.indexOf(
        "// ---------------------------------------------------------------------------",
      ),
    );
    expect(syncSource).toContain("await reconcileAllocatedWorkloadsOnNode(node.node_id)");
    expect(syncSource).not.toContain("countAllocatedWorkloadsOnNode(node.node_id)");
    expect(syncSource).not.toContain("setAllocatedCount");
    expect(reconcileSource.indexOf('.for("update")')).toBeGreaterThanOrEqual(0);
    expect(reconcileSource.indexOf('.for("update")')).toBeLessThan(
      reconcileSource.indexOf("countAllocatedWorkloadsOnNodeWithDatabase(tx, nodeId)"),
    );
  });
});
