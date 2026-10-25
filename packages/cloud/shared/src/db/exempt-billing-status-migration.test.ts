/**
 * Applies migration 0208 against real PGlite rows and proves the historical
 * billing_status CHECK (added by 0053/0056, table renamed by 0095) starts out
 * rejecting 'exempt', is widened to the canonical AgentBillingStatus set, stays
 * closed to unknown statuses, is safe to apply twice, and leaves existing rows
 * unchanged (#20021). Real migration SQL, no Drizzle schema push.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION_PATH = join(
  import.meta.dir,
  "migrations/0208_allow_exempt_agent_billing_status.sql",
);
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf8");

const ACTIVE_ID = "00000000-0000-4000-8000-0000000000a1";
const SUSPENDED_ID = "00000000-0000-4000-8000-0000000000a2";
const EXEMPT_ID = "00000000-0000-4000-8000-0000000000a3";
const UNKNOWN_ID = "00000000-0000-4000-8000-0000000000a4";

let client: PGlite | null = null;

afterEach(async () => {
  if (client) {
    await client.close();
    client = null;
  }
});

/**
 * Reproduce the migrated production shape this migration targets: 0053 added
 * billing_status, 0056 added the CHECK without 'exempt', and 0095 renamed the
 * table to agent_sandboxes while keeping the historical constraint name.
 */
async function seedHistoricalShape(db: PGlite): Promise<void> {
  await db.exec(`
    CREATE TABLE "agent_sandboxes" (
      id UUID PRIMARY KEY,
      billing_status TEXT NOT NULL DEFAULT 'active'
    );
    ALTER TABLE "agent_sandboxes" ADD CONSTRAINT "billing_status_check"
      CHECK (billing_status IN ('active', 'warning', 'shutdown_pending', 'suspended'));
    INSERT INTO "agent_sandboxes" (id, billing_status) VALUES
      ('${ACTIVE_ID}', 'active'),
      ('${SUSPENDED_ID}', 'suspended');
  `);
}

async function insertStatus(db: PGlite, id: string, status: string): Promise<void> {
  await db.query("INSERT INTO agent_sandboxes (id, billing_status) VALUES ($1, $2)", [id, status]);
}

async function statusRows(db: PGlite): Promise<Array<{ id: string; billing_status: string }>> {
  const result = await db.query<{ id: string; billing_status: string }>(
    "SELECT id, billing_status FROM agent_sandboxes ORDER BY id",
  );
  return result.rows;
}

describe("0208 allow exempt agent billing status (#20021)", () => {
  test("historical CHECK rejects 'exempt' before the migration", async () => {
    client = new PGlite();
    await seedHistoricalShape(client);

    await expect(insertStatus(client, EXEMPT_ID, "exempt")).rejects.toThrow(/billing_status_check/);
  });

  test("widens the CHECK to 'exempt', keeps unknown statuses out, applies twice, and preserves rows", async () => {
    client = new PGlite();
    await seedHistoricalShape(client);

    await client.exec(MIGRATION_SQL);
    await client.exec(MIGRATION_SQL);

    await insertStatus(client, EXEMPT_ID, "exempt");
    await expect(insertStatus(client, UNKNOWN_ID, "free-tier")).rejects.toThrow(
      /billing_status_check/,
    );

    expect(await statusRows(client)).toEqual([
      { id: ACTIVE_ID, billing_status: "active" },
      { id: SUSPENDED_ID, billing_status: "suspended" },
      { id: EXEMPT_ID, billing_status: "exempt" },
    ]);
  });

  test("migration constraint matches the canonical AgentBillingStatus contract exactly", async () => {
    client = new PGlite();
    await seedHistoricalShape(client);
    await client.exec(MIGRATION_SQL);

    // Canonical set from packages/cloud/shared/src/db/schemas/agent-sandboxes.ts.
    const canonical = ["active", "warning", "suspended", "shutdown_pending", "exempt"];
    for (const [index, status] of canonical.entries()) {
      await insertStatus(client, `00000000-0000-4000-8000-0000000000b${index}`, status);
    }

    const count = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM agent_sandboxes",
    );
    expect(count.rows[0]?.count).toBe(String(2 + canonical.length));
  });
});
