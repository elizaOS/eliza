/** Real-Postgres proof for the expand-only global backup-operation lane. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL("./migrations/0313_agent_backup_operation_lane.sql", import.meta.url);
const journalUrl = new URL("./migrations/meta/_journal.json", import.meta.url);
const migration = readFileSync(migrationUrl, "utf8");

const ORGANIZATION_A = "00000000-0000-4000-8000-00000000f001";
const ORGANIZATION_B = "00000000-0000-4000-8000-00000000f002";
const BACKUP_ID = "00000000-0000-4000-8000-00000000f003";
const OPERATION_ID = "00000000-0000-4000-8000-00000000f004";
const GENERATION = "00000000-0000-4000-8000-00000000f005";
const NODE_A = "00000000-0000-4000-8000-00000000f006";
const NODE_B = "00000000-0000-4000-8000-00000000f007";
const HISTORY_A1 = "00000000-0000-4000-8000-00000000f008";
const HISTORY_A2 = "00000000-0000-4000-8000-00000000f009";
const HISTORY_B = "00000000-0000-4000-8000-00000000f00a";
const INCARNATION_A = "00000000-0000-4000-8000-00000000f00b";
const INCARNATION_B = "00000000-0000-4000-8000-00000000f00c";

async function createPrerequisites(database: PGlite): Promise<void> {
  await database.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE docker_nodes (id uuid PRIMARY KEY);
    CREATE TABLE agent_node_incarnation_histories (
      id uuid PRIMARY KEY,
      docker_node_record_id uuid NOT NULL,
      node_incarnation uuid NOT NULL,
      CONSTRAINT agent_node_incarnation_histories_receipt_authority_unique
        UNIQUE (id, docker_node_record_id, node_incarnation)
    );
    INSERT INTO organizations (id) VALUES ('${ORGANIZATION_A}'), ('${ORGANIZATION_B}');
    INSERT INTO docker_nodes (id) VALUES ('${NODE_A}'), ('${NODE_B}');
    INSERT INTO agent_node_incarnation_histories (
      id, docker_node_record_id, node_incarnation
    ) VALUES
      ('${HISTORY_A1}', '${NODE_A}', '${INCARNATION_A}'),
      ('${HISTORY_A2}', '${NODE_A}', '${INCARNATION_A}'),
      ('${HISTORY_B}', '${NODE_B}', '${INCARNATION_B}');
  `);
}

async function applyMigration(database: PGlite): Promise<void> {
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
}

async function withDatabase(run: (database: PGlite) => Promise<void>): Promise<void> {
  const database = new PGlite();
  try {
    await createPrerequisites(database);
    await applyMigration(database);
    await run(database);
  } finally {
    await database.close();
  }
}

describe("agent backup operation lane migration", () => {
  test("is journaled in the next append-only slot", async () => {
    const journal = (await Bun.file(journalUrl).json()) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(
      journal.entries
        .filter((entry) => entry.tag.includes("agent_backup_operation_lane"))
        .map(({ idx, tag }) => ({ idx, tag })),
    ).toEqual([{ idx: 296, tag: "0313_agent_backup_operation_lane" }]);
  });

  test("applies twice and preserves exactly one seeded singleton", async () => {
    await withDatabase(async (database) => {
      await applyMigration(database);
      const rows = await database.query<{
        singleton: boolean;
        claim_sequence: string;
        owner_id: string | null;
      }>(`
        SELECT singleton, claim_sequence::text, owner_id
        FROM agent_backup_operation_lane
      `);
      expect(rows.rows).toEqual([{ singleton: true, claim_sequence: "0", owner_id: null }]);
      await expect(
        database.exec(`INSERT INTO agent_backup_operation_lane (singleton) VALUES (false)`),
      ).rejects.toThrow(/singleton_check/);
      await expect(
        database.exec(`INSERT INTO agent_backup_operation_lane (singleton) VALUES (true)`),
      ).rejects.toThrow(/duplicate key|unique constraint/i);
    });
  });

  test("rejects partial claims and enforces the 255-byte canonical owner boundary", async () => {
    await withDatabase(async (database) => {
      await expect(
        database.exec(`UPDATE agent_backup_operation_lane SET owner_id = 'worker-a'`),
      ).rejects.toThrow(/shape_check/);

      await database.exec(`
        UPDATE agent_backup_operation_lane SET
          owner_id = '${"a".repeat(255)}', generation = '${GENERATION}',
          organization_id = '${ORGANIZATION_A}', backup_id = '${BACKUP_ID}',
          operation_id = '${OPERATION_ID}', claimed_at = '2026-08-25T10:00:00Z',
          lease_expires_at = '2026-08-25T10:05:00Z', claim_sequence = 1
      `);
      await expect(
        database.query(`UPDATE agent_backup_operation_lane SET owner_id = $1`, ["é".repeat(128)]),
      ).rejects.toThrow(/shape_check/);
      await database.query(`UPDATE agent_backup_operation_lane SET owner_id = $1`, [
        `${"é".repeat(127)}a`,
      ]);
      const owner = await database.query<{ bytes: number }>(`
        SELECT octet_length(owner_id)::integer AS bytes FROM agent_backup_operation_lane
      `);
      expect(owner.rows).toEqual([{ bytes: 255 }]);
      await expect(
        database.query(`UPDATE agent_backup_operation_lane SET owner_id = $1`, ["worker\ncontrol"]),
      ).rejects.toThrow(/shape_check/);
      await expect(
        database.exec(`UPDATE agent_backup_operation_lane SET claim_sequence = 0`),
      ).rejects.toThrow(/shape_check/);
      await expect(
        database.exec(`
          UPDATE agent_backup_operation_lane
          SET released_at = '2026-08-25T09:59:59Z'
        `),
      ).rejects.toThrow(/shape_check/);
    });
  });

  test("enforces tenant fairness counters, sequence uniqueness, foreign keys, and cascade", async () => {
    await withDatabase(async (database) => {
      await database.exec(`
        INSERT INTO agent_backup_operation_tenant_watermarks (
          organization_id, last_backup_id, last_operation_id,
          last_service_sequence, service_count, last_served_at
        ) VALUES (
          '${ORGANIZATION_A}', '${BACKUP_ID}', '${OPERATION_ID}', 1, 1, NOW()
        )
      `);
      await expect(
        database.exec(`
          INSERT INTO agent_backup_operation_tenant_watermarks (
            organization_id, last_backup_id, last_operation_id,
            last_service_sequence, service_count, last_served_at
          ) VALUES (
            '${ORGANIZATION_B}', '${BACKUP_ID}', '${OPERATION_ID}', 1, 1, NOW()
          )
        `),
      ).rejects.toThrow(/sequence_uidx|unique constraint/i);
      await expect(
        database.exec(`
          INSERT INTO agent_backup_operation_tenant_watermarks (
            organization_id, last_backup_id, last_operation_id,
            last_service_sequence, service_count, last_served_at
          ) VALUES (
            '${ORGANIZATION_B}', '${BACKUP_ID}', '${OPERATION_ID}', 2, 0, NOW()
          )
        `),
      ).rejects.toThrow(/counters_check/);
      await expect(
        database.exec(`
          INSERT INTO agent_backup_operation_tenant_watermarks (
            organization_id, last_backup_id, last_operation_id,
            last_service_sequence, service_count, last_served_at
          ) VALUES (
            '00000000-0000-4000-8000-00000000ffff', '${BACKUP_ID}',
            '${OPERATION_ID}', 2, 1, NOW()
          )
        `),
      ).rejects.toThrow(/foreign key/i);

      await database.exec(`DELETE FROM organizations WHERE id = '${ORGANIZATION_A}'`);
      const remaining = await database.query<{ count: number }>(`
        SELECT count(*)::integer AS count FROM agent_backup_operation_tenant_watermarks
      `);
      expect(remaining.rows).toEqual([{ count: 0 }]);
    });
  });

  test("keys node fairness by exact history occurrence and cleans it with the live node", async () => {
    await withDatabase(async (database) => {
      await database.exec(`
        INSERT INTO agent_backup_operation_node_watermarks (
          source_node_history_id, source_node_record_id, source_node_incarnation,
          last_backup_id, last_operation_id, last_service_sequence, service_count, last_served_at
        ) VALUES
          ('${HISTORY_A1}', '${NODE_A}', '${INCARNATION_A}', '${BACKUP_ID}', '${OPERATION_ID}', 1, 1, NOW()),
          ('${HISTORY_A2}', '${NODE_A}', '${INCARNATION_A}', '${BACKUP_ID}', '${OPERATION_ID}', 2, 1, NOW())
      `);
      await expect(
        database.exec(`
          INSERT INTO agent_backup_operation_node_watermarks (
            source_node_history_id, source_node_record_id, source_node_incarnation,
            last_backup_id, last_operation_id, last_service_sequence, service_count, last_served_at
          ) VALUES (
            '${HISTORY_B}', '${NODE_A}', '${INCARNATION_B}', '${BACKUP_ID}',
            '${OPERATION_ID}', 3, 1, NOW()
          )
        `),
      ).rejects.toThrow(/occurrence_fkey|foreign key/i);
      await expect(
        database.exec(`
          INSERT INTO agent_backup_operation_node_watermarks (
            source_node_history_id, source_node_record_id, source_node_incarnation,
            last_backup_id, last_operation_id, last_service_sequence, service_count, last_served_at
          ) VALUES (
            '${HISTORY_B}', '${NODE_B}', '${INCARNATION_B}', '${BACKUP_ID}',
            '${OPERATION_ID}', 3, 0, NOW()
          )
        `),
      ).rejects.toThrow(/counters_check/);
      await expect(
        database.exec(`
          INSERT INTO agent_backup_operation_node_watermarks (
            source_node_history_id, source_node_record_id, source_node_incarnation,
            last_backup_id, last_operation_id, last_service_sequence, service_count, last_served_at
          ) VALUES (
            '${HISTORY_B}', '${NODE_B}', '${INCARNATION_B}', '${BACKUP_ID}',
            '${OPERATION_ID}', 1, 1, NOW()
          )
        `),
      ).rejects.toThrow(/sequence_uidx|unique constraint/i);
      await expect(
        database.exec(`DELETE FROM agent_node_incarnation_histories WHERE id = '${HISTORY_A1}'`),
      ).rejects.toThrow(/foreign key/i);

      await database.exec(`DELETE FROM docker_nodes WHERE id = '${NODE_A}'`);
      const remaining = await database.query<{ count: number }>(`
        SELECT count(*)::integer AS count FROM agent_backup_operation_node_watermarks
      `);
      expect(remaining.rows).toEqual([{ count: 0 }]);
    });
  });
});
