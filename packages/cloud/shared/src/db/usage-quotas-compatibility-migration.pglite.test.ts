/** Proves the 0282_01 compatibility restore against a real PostgreSQL-compatible catalog. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000029";
const QUOTA_ID = "00000000-0000-4000-8000-000000000283";
const migration = readFileSync(
  new URL("./migrations/0282_01_restore_usage_quotas_compatibility.sql", import.meta.url),
  "utf8",
).replaceAll("--> statement-breakpoint", "");

const historicalUsageQuotasSchema = `
  CREATE TABLE usage_quotas (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    quota_type text NOT NULL,
    model_name text,
    period_type text DEFAULT 'weekly' NOT NULL,
    credits_limit numeric(10,2) NOT NULL,
    current_usage numeric(10,2) DEFAULT '0.00' NOT NULL,
    period_start timestamp NOT NULL,
    period_end timestamp NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    CONSTRAINT usage_quotas_organization_id_organizations_id_fk
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
      ON DELETE CASCADE ON UPDATE NO ACTION
  );
  CREATE INDEX usage_quotas_org_id_idx ON usage_quotas USING btree (organization_id);
  CREATE INDEX usage_quotas_quota_type_idx ON usage_quotas USING btree (quota_type);
  CREATE INDEX usage_quotas_period_idx ON usage_quotas USING btree (period_start, period_end);
  CREATE INDEX usage_quotas_active_idx ON usage_quotas USING btree (is_active);
`;

const insertSentinel = `
  INSERT INTO usage_quotas (
    id, organization_id, quota_type, model_name, period_type, credits_limit,
    current_usage, period_start, period_end, is_active, created_at, updated_at
  ) VALUES (
    '${QUOTA_ID}', '${ORGANIZATION_ID}', 'model_specific', 'sentinel-model', 'monthly',
    123.45, 6.78, '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', false,
    '2026-08-01T01:00:00Z', '2026-08-02T01:00:00Z'
  );
`;

const oldFullSelection = `
  SELECT id, organization_id, quota_type, model_name, period_type, credits_limit,
    current_usage, period_start, period_end, is_active, created_at, updated_at
  FROM usage_quotas ORDER BY id
`;

async function createDatabase(): Promise<PGlite> {
  const database = new PGlite();
  await database.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    INSERT INTO organizations (id) VALUES ('${ORGANIZATION_ID}');
  `);
  return database;
}

async function applyMigration(database: PGlite): Promise<void> {
  await database.exec(`BEGIN; ${migration}; COMMIT;`);
}

describe("0282_01 restore usage_quotas compatibility", () => {
  test("recreates an empty historical table and supports the old complete selection", async () => {
    const database = await createDatabase();
    try {
      await applyMigration(database);

      const initiallyEmpty = await database.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM usage_quotas",
      );
      expect(initiallyEmpty.rows).toEqual([{ count: "0" }]);

      await database.exec(`
        INSERT INTO usage_quotas
          (id, organization_id, quota_type, credits_limit, period_start, period_end)
        VALUES
          ('${QUOTA_ID}', '${ORGANIZATION_ID}', 'global', 40.00,
           '2026-08-18T00:00:00Z', '2026-08-25T00:00:00Z');
      `);
      const selected = await database.query<Record<string, unknown>>(oldFullSelection);
      expect(Object.keys(selected.rows[0] ?? {})).toEqual([
        "id",
        "organization_id",
        "quota_type",
        "model_name",
        "period_type",
        "credits_limit",
        "current_usage",
        "period_start",
        "period_end",
        "is_active",
        "created_at",
        "updated_at",
      ]);
      expect(selected.rows[0]).toMatchObject({
        id: QUOTA_ID,
        organization_id: ORGANIZATION_ID,
        quota_type: "global",
        model_name: null,
        period_type: "weekly",
        credits_limit: "40.00",
        current_usage: "0.00",
        is_active: true,
      });

      const indexes = await database.query<{ indexname: string }>(`
        SELECT indexname FROM pg_indexes
        WHERE schemaname='public' AND tablename='usage_quotas'
        ORDER BY indexname
      `);
      expect(indexes.rows.map(({ indexname }) => indexname)).toEqual([
        "usage_quotas_active_idx",
        "usage_quotas_org_id_idx",
        "usage_quotas_period_idx",
        "usage_quotas_pkey",
        "usage_quotas_quota_type_idx",
      ]);

      await database.exec(`DELETE FROM organizations WHERE id='${ORGANIZATION_ID}'`);
      const afterCascade = await database.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM usage_quotas",
      );
      expect(afterCascade.rows).toEqual([{ count: "0" }]);
    } finally {
      await database.close();
    }
  });

  test("is idempotent on the historical table and preserves its sentinel", async () => {
    const database = await createDatabase();
    try {
      await database.exec(historicalUsageQuotasSchema);
      await database.exec(insertSentinel);
      const before = await database.query<Record<string, unknown>>(oldFullSelection);

      await applyMigration(database);
      await applyMigration(database);

      const after = await database.query<Record<string, unknown>>(oldFullSelection);
      expect(after.rows).toEqual(before.rows);
    } finally {
      await database.close();
    }
  });

  test("repairs missing compatibility objects without changing rows", async () => {
    const database = await createDatabase();
    try {
      await database.exec(historicalUsageQuotasSchema);
      await database.exec(insertSentinel);
      await database.exec(`
        ALTER TABLE usage_quotas
          DROP CONSTRAINT usage_quotas_organization_id_organizations_id_fk;
        DROP INDEX usage_quotas_period_idx;
      `);

      await applyMigration(database);

      const selected = await database.query<Record<string, unknown>>(oldFullSelection);
      expect(selected.rows).toHaveLength(1);
      expect(selected.rows[0]?.id).toBe(QUOTA_ID);
    } finally {
      await database.close();
    }
  });

  const driftCases = [
    {
      name: "column type",
      sql: "ALTER TABLE usage_quotas ALTER COLUMN credits_limit TYPE numeric(12,2)",
      error: /usage_quotas compatibility column collision/,
    },
    {
      name: "foreign-key action",
      sql: `
        ALTER TABLE usage_quotas
          DROP CONSTRAINT usage_quotas_organization_id_organizations_id_fk;
        ALTER TABLE usage_quotas
          ADD CONSTRAINT usage_quotas_organization_id_organizations_id_fk
          FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
      `,
      error: /usage_quotas compatibility constraint collision/,
    },
    {
      name: "same-named index definition",
      sql: `
        DROP INDEX usage_quotas_period_idx;
        CREATE INDEX usage_quotas_period_idx ON usage_quotas (period_end, period_start);
      `,
      error: /usage_quotas compatibility index collision/,
    },
  ] as const;

  for (const drift of driftCases) {
    test(`fails closed on a divergent ${drift.name}`, async () => {
      const database = await createDatabase();
      try {
        await database.exec(historicalUsageQuotasSchema);
        await database.exec(insertSentinel);
        await database.exec(drift.sql);

        await expect(applyMigration(database)).rejects.toThrow(drift.error);
        await database.exec("ROLLBACK");

        const sentinel = await database.query<{ id: string }>(
          "SELECT id::text AS id FROM usage_quotas",
        );
        expect(sentinel.rows).toEqual([{ id: QUOTA_ID }]);
      } finally {
        await database.close();
      }
    });
  }
});
