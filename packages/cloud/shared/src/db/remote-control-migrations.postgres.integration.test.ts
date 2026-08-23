/** Proves the canonical Devices migration suffix on disposable real PostgreSQL. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { acquireEphemeralPostgres } from "../lib/services/tenant-db/__tests__/ephemeral-postgres";

const enabled =
  process.env.APPS_TENANT_DB_EPHEMERAL === "1" || process.env.TEST_LANE === "post-merge";
const realPostgresTest = enabled ? test : test.skip;

const migrations = [
  "0068_add_remote_sessions",
  "0275_remote_sessions_first_class_expiry",
  "0305_secure_remote_hosts",
  "0306_secure_remote_command_relay",
  "0307_twilio_outbound_call_audit",
  "0308_remove_conversation_token_default",
  "0310_personal_shared_inbound_media_admission",
  "0311_remote_host_managed_network",
] as const;

realPostgresTest(
  "applies the complete canonical Devices suffix and constraints",
  async () => {
    const postgres = await acquireEphemeralPostgres();
    if (!postgres) {
      throw new Error("ephemeral PostgreSQL was requested but unavailable");
    }
    const client = new Client({ connectionString: postgres.dsn });

    try {
      await client.connect();
      await client.query(`
        CREATE TABLE organizations (id uuid PRIMARY KEY);
        CREATE TABLE users (id uuid PRIMARY KEY);
        CREATE TABLE eliza_sandboxes (
          id uuid PRIMARY KEY,
          organization_id uuid NOT NULL,
          user_id uuid NOT NULL,
          deleted_at timestamptz
        );
        CREATE TABLE conversations (
          id uuid PRIMARY KEY,
          settings jsonb NOT NULL DEFAULT
            '{"temperature":0.7,"maxTokens":2000,"topP":1,"frequencyPenalty":0,"presencePenalty":0,"systemPrompt":"You are a helpful AI assistant."}'::jsonb
        );
      `);

      for (const migration of migrations) {
        const source = await readFile(
          new URL(`./migrations/${migration}.sql`, import.meta.url),
          "utf8",
        );
        for (const statement of source.split("--> statement-breakpoint")) {
          if (statement.trim()) await client.query(statement);
        }
      }

      const tables = await client.query<{ table_name: string }>(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN (
            'remote_sessions',
            'remote_hosts',
            'remote_command_envelopes'
          )
        ORDER BY table_name
      `);
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "remote_command_envelopes",
        "remote_hosts",
        "remote_sessions",
      ]);

      const columns = await client.query<{
        table_name: string;
        column_name: string;
      }>(`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (
            ('remote_sessions', 'controller_device_id'),
            ('remote_sessions', 'host_id'),
            ('remote_sessions', 'grant_expires_at'),
            ('remote_hosts', 'host_token_hash'),
            ('remote_hosts', 'headscale_preauth_key_id'),
            ('remote_hosts', 'headscale_cleanup_pending'),
            ('remote_command_envelopes', 'started_at'),
            ('remote_command_envelopes', 'terminal_at')
          )
        ORDER BY table_name, column_name
      `);
      expect(columns.rows).toHaveLength(8);

      const constraints = await client.query<{
        name: string;
        definition: string;
      }>(`
        SELECT conname AS name, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conname IN (
          'remote_sessions_exactly_one_target_check',
          'remote_sessions_host_authority_shape_check',
          'remote_command_envelopes_lifecycle_shape_check'
        )
        ORDER BY conname
      `);
      expect(constraints.rows).toHaveLength(3);
      const definitions = constraints.rows
        .map((row) => `${row.name}: ${row.definition}`)
        .join("\n");
      expect(definitions).toContain("execution_ambiguous");
      expect(definitions).toContain("controller_device_id");
      expect(definitions).toContain("host_id");
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  },
  120_000,
);
