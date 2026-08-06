/**
 * Applies migration 0190 to a real PGlite table and proves its scope: it
 * releases container placement ONLY from legacy shared-tier rows whose
 * heartbeat has been stale for over a week, and leaves the warm pool, the
 * deletion machinery, dedicated tiers, and any recently-alive row untouched.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const TIMEOUT = 60_000;
const migrationSql = readFileSync(
  fileURLToPath(
    new URL("./migrations/0190_shared_rows_release_stale_placement.sql", import.meta.url),
  ),
  "utf8",
);

/** One row per boundary the migration must respect. */
const ROWS = {
  legacyShared: "00000000-0000-4000-8000-000000000190",
  warmPool: "00000000-0000-4000-8000-000000000191",
  deletionPending: "00000000-0000-4000-8000-000000000192",
  dedicated: "00000000-0000-4000-8000-000000000193",
  recentlyAliveShared: "00000000-0000-4000-8000-000000000194",
  neverBeatShared: "00000000-0000-4000-8000-000000000195",
} as const;

let dbWrite: typeof import("./client").dbWrite;
let closeDb: typeof import("./client").closeDatabaseConnectionsForTests | undefined;
let databaseReady = true;

async function placement(id: string): Promise<{
  node_id: string | null;
  container_name: string | null;
  status: string;
}> {
  const result = await dbWrite.execute(
    `SELECT node_id, container_name, status FROM agent_sandboxes WHERE id = '${id}'`,
  );
  return (
    result as unknown as {
      rows: Array<{
        node_id: string | null;
        container_name: string | null;
        status: string;
      }>;
    }
  ).rows[0];
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("./client"));
    const { PROVISIONING_JOB_TEST_TABLES } = await import(
      "../lib/services/__tests__/tier-upgrade-pglite-schema"
    );
    for (const ddl of PROVISIONING_JOB_TEST_TABLES) {
      if (ddl.includes('CREATE TABLE IF NOT EXISTS "agent_sandboxes"')) {
        await dbWrite.execute(ddl);
      }
    }

    const insert = (
      id: string,
      tier: string,
      status: string,
      poolStatus: string | null,
      beat: string | null,
    ) =>
      dbWrite.execute(`
        INSERT INTO agent_sandboxes
          (id, organization_id, user_id, execution_tier, status, pool_status,
           node_id, container_name, sandbox_id, bridge_url, health_url,
           last_heartbeat_at)
        VALUES
          ('${id}', '00000000-0000-4000-8000-000000000001',
           '00000000-0000-4000-8000-000000000002', '${tier}', '${status}',
           ${poolStatus === null ? "NULL" : `'${poolStatus}'`},
           gen_random_uuid(), 'agent-${id.slice(-4)}', 'sb-${id.slice(-4)}',
           'http://x:2138', 'http://x:2139',
           ${beat === null ? "NULL" : `NOW() - INTERVAL '${beat}'`});
      `);

    await insert(ROWS.legacyShared, "shared", "running", null, "26 days");
    await insert(ROWS.warmPool, "shared", "running", "unclaimed", "26 days");
    await insert(ROWS.deletionPending, "shared", "deletion_pending", null, "26 days");
    await insert(ROWS.dedicated, "dedicated-always", "running", null, "26 days");
    await insert(ROWS.recentlyAliveShared, "shared", "running", null, "1 hour");
    await insert(ROWS.neverBeatShared, "shared", "running", null, null);

    for (const statement of migrationSql.split("--> statement-breakpoint")) {
      if (statement.trim()) await dbWrite.execute(statement);
    }
  } catch (error) {
    databaseReady = false;
    console.warn("[shared-rows-release] PGlite setup failed", error);
  }
}, TIMEOUT);

afterAll(async () => {
  await closeDb?.();
});

describe("0190 releases stale legacy shared placement", () => {
  test(
    "the legacy shared row loses its placement and stays running",
    async () => {
      if (!databaseReady) throw new Error("PGlite unavailable");
      const row = await placement(ROWS.legacyShared);
      // Running with NULL locators IS the modern container-free shared shape;
      // the row becomes an ordinary shared agent rather than a fake container.
      expect(row).toEqual({
        node_id: null,
        container_name: null,
        status: "running",
      });
    },
    TIMEOUT,
  );

  test(
    "a shared row that never heartbeat is released too",
    async () => {
      if (!databaseReady) throw new Error("PGlite unavailable");
      expect((await placement(ROWS.neverBeatShared)).node_id).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "a warm-pool row keeps its placement — the pool lifecycle owns it",
    async () => {
      if (!databaseReady) throw new Error("PGlite unavailable");
      expect((await placement(ROWS.warmPool)).node_id).not.toBeNull();
    },
    TIMEOUT,
  );

  test(
    "a deletion_pending row keeps its locator for the delete-retry sweep",
    async () => {
      if (!databaseReady) throw new Error("PGlite unavailable");
      expect((await placement(ROWS.deletionPending)).node_id).not.toBeNull();
    },
    TIMEOUT,
  );

  test(
    "a dedicated-tier row is untouched whatever its heartbeat says",
    async () => {
      if (!databaseReady) throw new Error("PGlite unavailable");
      expect((await placement(ROWS.dedicated)).node_id).not.toBeNull();
    },
    TIMEOUT,
  );

  test(
    "a shared row with a recent heartbeat is left as live evidence",
    async () => {
      if (!databaseReady) throw new Error("PGlite unavailable");
      expect((await placement(ROWS.recentlyAliveShared)).node_id).not.toBeNull();
    },
    TIMEOUT,
  );
});
