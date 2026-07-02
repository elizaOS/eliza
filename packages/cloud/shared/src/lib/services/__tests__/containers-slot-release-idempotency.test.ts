/**
 * Idempotent node-slot release (#8342).
 *
 * Pins that `containersRepository.tryReleaseNodeSlot` decrements a node's
 * `allocated_count` EXACTLY ONCE per container, even when the stop/delete job is
 * re-claimed (the crash-retry window). The first call stamps a one-way
 * `metadata.slotReleasedAt` marker and decrements the node in the SAME
 * transaction; a re-run finds the marker set, matches no row, and does NOT
 * decrement again — so a re-claim can never free a phantom slot belonging to a
 * live container. The container `status` can't gate this (the billing cron
 * pre-sets `status='stopped'` before the daemon ever runs), which is exactly why
 * the marker lives in `metadata`.
 *
 * Runs against in-process PGlite so the real SQL (jsonb_set / jsonb_exists,
 * GREATEST clamping, the cross-table transaction) executes. Fails loudly (via the
 * `pgliteReady` guard) if PGlite ever fails to initialize — never a silent skip.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const PGLITE_TIMEOUT = 60000;

const ORG_ID = "00000000-0000-0000-0000-0000000000a1";
const CONTAINER_ID = "00000000-0000-0000-0000-0000000000c3";
const NODE_ID = "node-1";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let containersRepository: typeof import("../../../db/repositories/containers").containersRepository;
let pgliteReady = true;

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ containersRepository } = await import("../../../db/repositories/containers"));

    // Minimal schema: only the columns tryReleaseNodeSlot reads/writes.
    const ddl = [
      `CREATE TABLE IF NOT EXISTS containers (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        node_id text,
        metadata jsonb NOT NULL DEFAULT '{}',
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS docker_nodes (
        node_id text PRIMARY KEY,
        allocated_count integer NOT NULL DEFAULT 0,
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
    ];
    for (const stmt of ddl) {
      await dbWrite.execute(stmt);
    }
  } catch (error) {
    pgliteReady = false;
    console.warn("[containers-slot-release] PGlite unavailable, skipping DB cases:", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

async function allocatedCount(): Promise<number> {
  const res = await dbWrite.execute(
    `SELECT allocated_count FROM docker_nodes WHERE node_id = '${NODE_ID}';`,
  );
  return Number((res.rows[0] as { allocated_count: number }).allocated_count);
}

async function markerPresent(): Promise<boolean> {
  const res = await dbWrite.execute(
    `SELECT jsonb_exists(metadata, 'slotReleasedAt') AS present FROM containers WHERE id = '${CONTAINER_ID}';`,
  );
  return Boolean((res.rows[0] as { present: boolean }).present);
}

describe("containersRepository.tryReleaseNodeSlot — idempotency", () => {
  test(
    "releases the slot exactly once across a re-run",
    async () => {
      if (!pgliteReady) return;
      await dbWrite.execute(`DELETE FROM containers;`);
      await dbWrite.execute(`DELETE FROM docker_nodes;`);
      await dbWrite.execute(
        `INSERT INTO docker_nodes (node_id, allocated_count) VALUES ('${NODE_ID}', 2);`,
      );
      await dbWrite.execute(
        `INSERT INTO containers (id, organization_id, node_id, metadata)
         VALUES ('${CONTAINER_ID}', '${ORG_ID}', '${NODE_ID}', '{}'::jsonb);`,
      );

      // First release: transitions the slot, marks metadata, decrements once.
      const first = await containersRepository.tryReleaseNodeSlot(CONTAINER_ID, ORG_ID, NODE_ID);
      expect(first).toBe(true);
      expect(await allocatedCount()).toBe(1);
      expect(await markerPresent()).toBe(true);

      // Re-run (re-claimed job): marker already set → no transition, no decrement.
      const second = await containersRepository.tryReleaseNodeSlot(CONTAINER_ID, ORG_ID, NODE_ID);
      expect(second).toBe(false);
      expect(await allocatedCount()).toBe(1); // NOT decremented a second time

      // A third re-run is still a no-op.
      const third = await containersRepository.tryReleaseNodeSlot(CONTAINER_ID, ORG_ID, NODE_ID);
      expect(third).toBe(false);
      expect(await allocatedCount()).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "clamps at 0 — never drives allocated_count negative",
    async () => {
      if (!pgliteReady) return;
      await dbWrite.execute(`DELETE FROM containers;`);
      await dbWrite.execute(`DELETE FROM docker_nodes;`);
      await dbWrite.execute(
        `INSERT INTO docker_nodes (node_id, allocated_count) VALUES ('${NODE_ID}', 0);`,
      );
      await dbWrite.execute(
        `INSERT INTO containers (id, organization_id, node_id, metadata)
         VALUES ('${CONTAINER_ID}', '${ORG_ID}', '${NODE_ID}', '{}'::jsonb);`,
      );

      const released = await containersRepository.tryReleaseNodeSlot(CONTAINER_ID, ORG_ID, NODE_ID);
      expect(released).toBe(true); // the marker transition still happened
      expect(await allocatedCount()).toBe(0); // GREATEST floor held
    },
    PGLITE_TIMEOUT,
  );
});

// Loud guard: PGlite is in-process (no network), so `pgliteReady` must be true.
// If pushSchema/PGlite ever fails to init, the DB-dependent tests above
// early-return; this turns that silent no-op into a hard CI failure so a
// money-path proof can never masquerade as a vacuous green.
test("pglite schema applied — never a silent skip", () => {
  expect(pgliteReady).toBe(true);
});
