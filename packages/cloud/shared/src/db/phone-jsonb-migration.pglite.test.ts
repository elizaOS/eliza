/** Exercises the exact Phone JSONB migration transaction against real PostgreSQL semantics. */

import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL("./migrations/0295_phone_message_payload_jsonb.sql", import.meta.url);
const journalUrl = new URL("./migrations/meta/_journal.json", import.meta.url);
const migrationSource = await Bun.file(migrationUrl).text();
const MIGRATION_TAG = "0295_phone_message_payload_jsonb";
const ORGANIZATION_ID = "61111111-1111-4111-8111-111111111111";
const OTHER_ORGANIZATION_ID = "63333333-3333-4333-8333-333333333333";
const PHONE_NUMBER_ID = "62222222-2222-4222-8222-222222222222";

async function createLegacyTables(database: PGlite): Promise<void> {
  await database.exec(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY
    );
    CREATE TABLE agent_phone_numbers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL DEFAULT '${ORGANIZATION_ID}'
        REFERENCES organizations(id) ON DELETE CASCADE,
      metadata text DEFAULT '{}'
    );
    CREATE TABLE phone_message_log (
      phone_number_id uuid NOT NULL DEFAULT '${PHONE_NUMBER_ID}'
        REFERENCES agent_phone_numbers(id) ON DELETE CASCADE,
      media_urls text,
      media_urls_storage text NOT NULL DEFAULT 'inline',
      media_urls_key text,
      metadata text DEFAULT '{}',
      metadata_storage text NOT NULL DEFAULT 'inline',
      metadata_key text
    );
    CREATE TABLE agent_phone_contacts (
      metadata text DEFAULT '{}' NOT NULL
    );
    CREATE TABLE phone_gateway_devices (
      metadata text DEFAULT '{}' NOT NULL
    );
    INSERT INTO organizations (id) VALUES ('${ORGANIZATION_ID}'), ('${OTHER_ORGANIZATION_ID}');
    INSERT INTO agent_phone_numbers (id) VALUES ('${PHONE_NUMBER_ID}');
  `);
}

async function applyMigration(database: PGlite): Promise<void> {
  await database.transaction(async (transaction) => {
    for (const statement of migrationSource.split("--> statement-breakpoint")) {
      if (statement.trim()) await transaction.exec(statement);
    }
  });
}

async function phoneColumnTypes(database: PGlite): Promise<string[]> {
  const result = await database.query<{ data_type: string }>(`
    SELECT data_type
    FROM information_schema.columns
    WHERE (table_name, column_name) IN (
      ('agent_phone_numbers', 'metadata'),
      ('phone_message_log', 'media_urls'),
      ('phone_message_log', 'metadata'),
      ('agent_phone_contacts', 'metadata'),
      ('phone_gateway_devices', 'metadata')
    )
    ORDER BY table_name, column_name
  `);
  return result.rows.map(({ data_type }) => data_type);
}

describe("0295 phone message payload JSONB", () => {
  test("has one exact journal registration and migration path", async () => {
    const journal = JSON.parse(await Bun.file(journalUrl).text()) as {
      entries: Array<{
        idx: number;
        version: string;
        when: number;
        tag: string;
        breakpoints: boolean;
      }>;
    };
    const matchingEntries = journal.entries.filter(({ tag }) => tag === MIGRATION_TAG);
    if (matchingEntries.length !== 1) {
      throw new Error(`Expected exactly one ${MIGRATION_TAG} journal entry`);
    }
    const migrationEntry = matchingEntries[0]!;

    expect(migrationEntry).toEqual({
      idx: 278,
      version: "7",
      when: 1793736000001,
      tag: MIGRATION_TAG,
      breakpoints: true,
    });
    expect(new URL(`./migrations/${migrationEntry.tag}.sql`, import.meta.url).href).toBe(
      migrationUrl.href,
    );
    expect(new Set(journal.entries.map(({ idx }) => idx)).size).toBe(journal.entries.length);
    expect(new Set(journal.entries.map(({ tag }) => tag)).size).toBe(journal.entries.length);
  });

  test("converts all five columns losslessly and re-applies idempotently", async () => {
    const database = new PGlite();
    try {
      await createLegacyTables(database);
      const numericObject = '{"huge":1e400,"tiny":1e-400,"nested":{"value":9e999}}';
      await database.query("INSERT INTO agent_phone_numbers (metadata) VALUES ($1)", [
        numericObject,
      ]);
      await database.query("INSERT INTO phone_message_log (media_urls, metadata) VALUES ($1, $2)", [
        '["https://media.example.test/a","https://media.example.test/b"]',
        numericObject,
      ]);
      await database.query("INSERT INTO agent_phone_contacts (metadata) VALUES ($1)", [
        numericObject,
      ]);
      await database.query("INSERT INTO phone_gateway_devices (metadata) VALUES ($1)", [
        numericObject,
      ]);
      await database.query(
        `INSERT INTO phone_message_log (
          media_urls, media_urls_storage, media_urls_key,
          metadata, metadata_storage, metadata_key
        ) VALUES ($1, 'r2', $2, $3, 'r2', $4)`,
        [
          "[]",
          `phone-message-payloads/${ORGANIZATION_ID}/date/id/media_urls.txt`,
          "{}",
          `phone-message-payloads/${ORGANIZATION_ID}/date/id/metadata.txt`,
        ],
      );
      await database.exec(`
        INSERT INTO agent_phone_numbers DEFAULT VALUES;
        INSERT INTO agent_phone_contacts DEFAULT VALUES;
        INSERT INTO phone_gateway_devices DEFAULT VALUES;
      `);

      await applyMigration(database);
      await applyMigration(database);

      expect(await phoneColumnTypes(database)).toEqual(Array(5).fill("jsonb"));
      const constraints = await database.query<{ count: string }>(`
        SELECT count(*)::text AS count FROM pg_constraint
        WHERE conname IN (
          'agent_phone_numbers_metadata_object_check',
          'phone_message_log_media_urls_array_check',
          'phone_message_log_metadata_object_check',
          'agent_phone_contacts_metadata_object_check',
          'phone_gateway_devices_metadata_object_check'
        )
      `);
      expect(constraints.rows[0]?.count).toBe("5");

      const exact = await database.query<{
        huge_exact: boolean;
        nested_exact: boolean;
        tiny_exact: boolean;
      }>(`
        SELECT
          (metadata->>'huge')::numeric = 1e400::numeric AS huge_exact,
          (metadata->>'tiny')::numeric = 1e-400::numeric AS tiny_exact,
          (metadata#>>'{nested,value}')::numeric = 9e999::numeric AS nested_exact
        FROM agent_phone_numbers
        WHERE metadata ? 'huge'
      `);
      expect(exact.rows[0]).toEqual({
        huge_exact: true,
        nested_exact: true,
        tiny_exact: true,
      });

      const typedWrite = await database.query<{ media_type: string; metadata_type: string }>(`
        INSERT INTO phone_message_log (organization_id, media_urls, metadata)
        VALUES ('${ORGANIZATION_ID}', '["https://media.example.test/new"]'::jsonb, '{"ok":true}'::jsonb)
        RETURNING jsonb_typeof(media_urls) AS media_type,
          jsonb_typeof(metadata) AS metadata_type
      `);
      expect(typedWrite.rows[0]).toEqual({ media_type: "array", metadata_type: "object" });

      const ownership = await database.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM phone_message_log
        WHERE organization_id = '${ORGANIZATION_ID}'
      `);
      expect(ownership.rows[0]?.count).toBe("3");
      const ownerColumn = await database.query<{ is_nullable: string }>(`
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_name = 'phone_message_log' AND column_name = 'organization_id'
      `);
      expect(ownerColumn.rows[0]?.is_nullable).toBe("NO");

      const pointers = await database.query<{
        media_empty: boolean;
        media_urls_key: string;
        media_urls_storage: string;
        metadata_empty: boolean;
        metadata_key: string;
        metadata_storage: string;
      }>(`
        SELECT
          jsonb_array_length(media_urls) = 0 AS media_empty,
          media_urls_storage,
          media_urls_key,
          metadata = '{}'::jsonb AS metadata_empty,
          metadata_storage,
          metadata_key
        FROM phone_message_log
        WHERE media_urls_storage = 'r2'
      `);
      expect(pointers.rows[0]).toEqual({
        media_empty: true,
        media_urls_key: `phone-message-payloads/${ORGANIZATION_ID}/date/id/media_urls.txt`,
        media_urls_storage: "r2",
        metadata_empty: true,
        metadata_key: `phone-message-payloads/${ORGANIZATION_ID}/date/id/metadata.txt`,
        metadata_storage: "r2",
      });

      const legacyInsert = await database.query<{ organization_id: string }>(`
        INSERT INTO phone_message_log (media_urls, metadata)
        VALUES ('[]'::jsonb, '{}'::jsonb)
        RETURNING organization_id::text
      `);
      expect(legacyInsert.rows[0]?.organization_id).toBe(ORGANIZATION_ID);
      await expect(
        database.exec(`
          UPDATE agent_phone_numbers
          SET organization_id = '${OTHER_ORGANIZATION_ID}'
          WHERE id = '${PHONE_NUMBER_ID}'
        `),
      ).rejects.toThrow(/phone_message_log_phone_owner_fk/);
      await expect(
        database.exec(`
          UPDATE phone_message_log
          SET organization_id = '${OTHER_ORGANIZATION_ID}'
        `),
      ).rejects.toThrow(/phone message tenant is immutable/);

      for (const invalidWrite of [
        "INSERT INTO agent_phone_numbers (metadata) VALUES ('[]'::jsonb)",
        `INSERT INTO phone_message_log (organization_id, media_urls)
         VALUES ('${ORGANIZATION_ID}', '[1]'::jsonb)`,
        `INSERT INTO phone_message_log (organization_id, media_urls)
         VALUES ('${ORGANIZATION_ID}', '[["https://media.example.test/nested"]]'::jsonb)`,
        `INSERT INTO phone_message_log (organization_id, metadata)
         VALUES ('${ORGANIZATION_ID}', '[]'::jsonb)`,
        "INSERT INTO agent_phone_contacts (metadata) VALUES ('[]'::jsonb)",
        "INSERT INTO phone_gateway_devices (metadata) VALUES ('[]'::jsonb)",
      ]) {
        await expect(database.exec(invalidWrite)).rejects.toThrow(/check constraint/);
      }
    } finally {
      await database.close();
    }
  }, 30_000);

  test("rolls every conversion back when legacy JSON is malformed", async () => {
    const database = new PGlite();
    try {
      await createLegacyTables(database);
      await database.query("INSERT INTO agent_phone_numbers (metadata) VALUES ($1)", [
        '{"broken":',
      ]);

      await expect(applyMigration(database)).rejects.toThrow();
      expect(await phoneColumnTypes(database)).toEqual(Array(5).fill("text"));
    } finally {
      await database.close();
    }
  });

  test("rolls every conversion back when valid JSON has the wrong shape", async () => {
    const database = new PGlite();
    try {
      await createLegacyTables(database);
      await database.query("INSERT INTO phone_message_log (media_urls) VALUES ($1)", [
        '[["https://media.example.test/nested"]]',
      ]);

      await expect(applyMigration(database)).rejects.toThrow(
        /phone_message_log_media_urls_array_check/,
      );
      expect(await phoneColumnTypes(database)).toEqual(Array(5).fill("text"));
    } finally {
      await database.close();
    }
  });

  test("rolls back when a historical R2 key encodes another tenant", async () => {
    const database = new PGlite();
    try {
      await createLegacyTables(database);
      await database.query(
        `INSERT INTO phone_message_log (
          metadata, metadata_storage, metadata_key
        ) VALUES ('{}', 'r2', $1)`,
        ["phone-message-payloads/64444444-4444-4444-8444-444444444444/date/id/metadata.txt"],
      );

      await expect(applyMigration(database)).rejects.toThrow(
        /phone message object tenant audit failed/,
      );
      expect(await phoneColumnTypes(database)).toEqual(Array(5).fill("text"));
      const ownerColumn = await database.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM information_schema.columns
        WHERE table_name = 'phone_message_log' AND column_name = 'organization_id'
      `);
      expect(ownerColumn.rows[0]?.count).toBe("0");
    } finally {
      await database.close();
    }
  });
});
