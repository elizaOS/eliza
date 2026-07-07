/**
 * Regression coverage for live node-slot accounting (#15378).
 *
 * `countAllocatedWorkloadsOnNode` feeds both allocated_count reconciliation and
 * the autoscaler's capacity decision, so terminal agent lifecycle rows must not
 * hold live slots on a Docker node. This runs the real Drizzle count SQL against
 * in-process PGlite with only the columns the count query touches.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const PGLITE_TIMEOUT = 60000;

let dbWrite: typeof import("../../db/client").dbWrite;
let closeDb: typeof import("../../db/client").closeDatabaseConnectionsForTests | undefined;
let countAllocatedWorkloadsOnNode:
  | typeof import("./docker-node-workloads").countAllocatedWorkloadsOnNode
  | undefined;
let pgliteReady = true;

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../db/client"));
    ({ countAllocatedWorkloadsOnNode } = await import("./docker-node-workloads"));

    const ddl = [
      `CREATE TABLE IF NOT EXISTS containers (
        id text PRIMARY KEY,
        node_id text,
        status text NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS agent_sandboxes (
        id text PRIMARY KEY,
        node_id text,
        status text NOT NULL
      )`,
    ];
    for (const stmt of ddl) {
      await dbWrite.execute(stmt);
    }
  } catch (error) {
    pgliteReady = false;
    console.warn("[docker-node-workloads-count] PGlite unavailable, skipping DB cases:", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("countAllocatedWorkloadsOnNode", () => {
  test(
    "excludes terminal agent sandbox statuses from live slot pressure",
    async () => {
      if (!pgliteReady || !countAllocatedWorkloadsOnNode) return;
      await dbWrite.execute(`DELETE FROM containers;`);
      await dbWrite.execute(`DELETE FROM agent_sandboxes;`);

      for (const [id, status] of [
        ["container-running", "running"],
        ["container-pending", "pending"],
        ["container-stopped", "stopped"],
        ["container-failed", "failed"],
        ["container-deleted", "deleted"],
      ]) {
        await dbWrite.execute(
          `INSERT INTO containers (id, node_id, status) VALUES ('${id}', 'node-1', '${status}');`,
        );
      }

      for (const [id, status] of [
        ["agent-running", "running"],
        ["agent-provisioning", "provisioning"],
        ["agent-pending", "pending"],
        ["agent-disconnected", "disconnected"],
        ["agent-deletion-pending", "deletion_pending"],
        ["agent-stopped", "stopped"],
        ["agent-error", "error"],
        ["agent-sleeping", "sleeping"],
        ["agent-deletion-failed", "deletion_failed"],
        ["agent-other-node", "running"],
      ]) {
        const nodeId = id === "agent-other-node" ? "node-2" : "node-1";
        await dbWrite.execute(
          `INSERT INTO agent_sandboxes (id, node_id, status) VALUES ('${id}', '${nodeId}', '${status}');`,
        );
      }

      expect(await countAllocatedWorkloadsOnNode("node-1")).toBe(7);
    },
    PGLITE_TIMEOUT,
  );
});

test("PGlite schema applied for allocated workload counting - never a silent skip", () => {
  expect(pgliteReady).toBe(true);
  expect(countAllocatedWorkloadsOnNode).toBeDefined();
});
