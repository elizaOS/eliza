/** Executes the hosted WhatsApp credential cutover against real PostgreSQL semantics. */

import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

const migrationSource = await Bun.file(
  new URL("./migrations/0299_retire_hosted_whatsapp_credentials.sql", import.meta.url),
).text();

async function applyMigration(database: PGlite): Promise<void> {
  await database.transaction(async (transaction) => {
    for (const statement of migrationSource.split("--> statement-breakpoint")) {
      if (statement.trim()) await transaction.exec(statement);
    }
  });
}

describe("0299 hosted WhatsApp credential cutover", () => {
  test("atomically receipts and deletes every tenant credential, then fences recreation", async () => {
    const database = new PGlite();
    try {
      await database.exec(`
        CREATE TYPE secret_audit_action AS ENUM ('created', 'read', 'updated', 'deleted', 'rotated');
        CREATE TYPE secret_actor_type AS ENUM ('user', 'api_key', 'system', 'deployment', 'workflow');
        CREATE TABLE secrets (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          organization_id uuid NOT NULL,
          scope text NOT NULL DEFAULT 'organization',
          project_id uuid,
          environment text,
          name text NOT NULL,
          encrypted_value text NOT NULL
        );
        CREATE TABLE secret_audit_log (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          secret_id uuid,
          organization_id uuid NOT NULL,
          action secret_audit_action NOT NULL,
          secret_name text,
          actor_type secret_actor_type NOT NULL,
          actor_id text NOT NULL,
          source text,
          metadata jsonb NOT NULL DEFAULT '{}'
        );
        INSERT INTO secrets (organization_id, name, encrypted_value) VALUES
          ('00000000-0000-4000-8000-000000000001', 'WHATSAPP_ACCESS_TOKEN', 'cipher-a'),
          ('00000000-0000-4000-8000-000000000002', 'WHATSAPP_APP_SECRET', 'cipher-b'),
          ('00000000-0000-4000-8000-000000000002', 'DISCORD_BOT_TOKEN', 'keep-me');
        INSERT INTO secrets
          (organization_id, scope, project_id, name, encrypted_value)
        VALUES
          ('00000000-0000-4000-8000-000000000001', 'project',
           '00000000-0000-4000-8000-000000000003', 'WHATSAPP_ACCESS_TOKEN',
           'plugin-cipher');
      `);

      await applyMigration(database);
      await applyMigration(database);

      const remaining = await database.query<{ name: string; encrypted_value: string }>(
        "SELECT name, encrypted_value FROM secrets ORDER BY name",
      );
      expect(remaining.rows).toEqual([
        { name: "DISCORD_BOT_TOKEN", encrypted_value: "keep-me" },
        { name: "WHATSAPP_ACCESS_TOKEN", encrypted_value: "plugin-cipher" },
      ]);
      const receipts = await database.query<{
        actor_id: string;
        count: string;
        source: string;
      }>(`
        SELECT actor_id, count(*)::text AS count, source
        FROM secret_audit_log
        GROUP BY actor_id, source
      `);
      expect(receipts.rows).toEqual([
        { actor_id: "migration:0299", count: "2", source: "hosted-whatsapp-cutover" },
      ]);
      expect(JSON.stringify(receipts.rows)).not.toMatch(/cipher/u);
      await expect(
        database.exec(`INSERT INTO secrets (organization_id, name, encrypted_value)
          VALUES ('00000000-0000-4000-8000-000000000001', 'WHATSAPP_ACCESS_TOKEN', 'new')`),
      ).rejects.toMatchObject({ constraint: "secrets_hosted_whatsapp_retired" });
      await expect(
        database.exec("UPDATE secrets SET name = 'WHATSAPP_PHONE_NUMBER_ID'"),
      ).rejects.toMatchObject({ constraint: "secrets_hosted_whatsapp_retired" });
      await database.exec(`INSERT INTO secrets
        (organization_id, scope, project_id, name, encrypted_value)
        VALUES ('00000000-0000-4000-8000-000000000001', 'project',
          '00000000-0000-4000-8000-000000000004', 'WHATSAPP_PHONE_NUMBER_ID', 'plugin')`);
    } finally {
      await database.close();
    }
  });
});
