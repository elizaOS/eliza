/**
 * Replays the historical billing-status constraint and its append-only repair
 * against real PGlite, including the table rename present in deployed schemas.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { AgentBillingStatus } from "./schemas/agent-sandboxes";

const CANONICAL_AGENT_BILLING_STATUSES = [
  "active",
  "warning",
  "shutdown_pending",
  "suspended",
  "exempt",
] as const satisfies readonly AgentBillingStatus[];

type SameMembers<Left, Right> =
  Exclude<Left, Right> extends never ? (Exclude<Right, Left> extends never ? true : false) : false;

const TYPED_STATUS_SET_IS_EXACT: SameMembers<
  AgentBillingStatus,
  (typeof CANONICAL_AGENT_BILLING_STATUSES)[number]
> = true;

async function migrationSql(name: string): Promise<string> {
  return await readFile(new URL(`./migrations/${name}.sql`, import.meta.url), "utf8");
}

describe("0209 agent billing-status constraint", () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  test("adds exempt without weakening the migrated status contract", async () => {
    const database = new PGlite();
    databases.push(database);
    await database.exec(`
      CREATE TABLE "eliza_sandboxes" (
        "id" text PRIMARY KEY
      );
    `);
    await database.exec(await migrationSql("0053_add_eliza_billing_columns"));
    await database.exec(await migrationSql("0056_add_billing_status_check"));

    await expect(
      database.exec(`
        INSERT INTO "eliza_sandboxes" ("id", "billing_status")
        VALUES ('legacy-exempt', 'exempt');
      `),
    ).rejects.toThrow(/billing_status_check/);

    await database.exec(`
      INSERT INTO "eliza_sandboxes" ("id", "billing_status") VALUES
        ('active-row', 'active'),
        ('warning-row', 'warning'),
        ('shutdown-row', 'shutdown_pending'),
        ('suspended-row', 'suspended');
    `);
    const rowsBeforeRepair = await database.query<{ id: string; billing_status: string }>(`
      SELECT "id", "billing_status"
        FROM "eliza_sandboxes"
       ORDER BY "id";
    `);

    // Migration 0095 performs this rename before 0209 reaches deployed databases.
    await database.exec(`ALTER TABLE "eliza_sandboxes" RENAME TO "agent_sandboxes";`);
    const repairMigration = await migrationSql("0209_allow_exempt_agent_billing_status");
    await database.exec(repairMigration);
    await database.exec(repairMigration);

    const rowsAfterRepair = await database.query<{ id: string; billing_status: string }>(`
      SELECT "id", "billing_status"
        FROM "agent_sandboxes"
       ORDER BY "id";
    `);
    expect(rowsAfterRepair.rows).toEqual(rowsBeforeRepair.rows);

    await database.exec(`
      INSERT INTO "agent_sandboxes" ("id", "billing_status")
      VALUES ('exempt-row', 'exempt');
    `);
    await expect(
      database.exec(`
        INSERT INTO "agent_sandboxes" ("id", "billing_status")
        VALUES ('unknown-row', 'unknown');
      `),
    ).rejects.toThrow(/billing_status_check/);

    const persistedExempt = await database.query<{ billing_status: string }>(`
      SELECT "billing_status"
        FROM "agent_sandboxes"
       WHERE "id" = 'exempt-row';
    `);
    expect(persistedExempt.rows).toEqual([{ billing_status: "exempt" }]);

    const installedConstraints = await database.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'public.agent_sandboxes'::regclass
         AND conname = 'billing_status_check';
    `);
    expect(installedConstraints.rows).toHaveLength(1);
    const [installedConstraint] = installedConstraints.rows;
    if (!installedConstraint) {
      throw new Error("0209 did not install billing_status_check");
    }
    const installedStatuses = Array.from(
      installedConstraint.definition.matchAll(/'([^']+)'/g),
      (match) => match[1],
    ).sort();

    expect(TYPED_STATUS_SET_IS_EXACT).toBe(true);
    expect(installedStatuses).toEqual([...CANONICAL_AGENT_BILLING_STATUSES].sort());
  });
});
