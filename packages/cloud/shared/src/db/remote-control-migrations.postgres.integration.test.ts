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
  "0309_retire_legacy_bluebubbles_gateways",
  "0310_personal_shared_inbound_media_admission",
  "0312_remote_host_managed_network",
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
        CREATE TABLE phone_gateway_devices (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          send_method text,
          metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
          is_active boolean NOT NULL DEFAULT true,
          can_send_sms boolean NOT NULL DEFAULT true,
          can_receive_sms boolean NOT NULL DEFAULT true,
          can_send_imessage boolean NOT NULL DEFAULT true,
          can_receive_imessage boolean NOT NULL DEFAULT true,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO phone_gateway_devices (send_method)
        VALUES ('bluebubbles-local-bridge');
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
          'remote_hosts_status_check',
          'remote_sessions_exactly_one_target_check',
          'remote_sessions_host_authority_shape_check',
          'remote_hosts_status_check',
          'remote_command_envelopes_lifecycle_shape_check'
        )
        ORDER BY conname
      `);
      expect(constraints.rows).toHaveLength(4);
      const definitions = constraints.rows
        .map((row) => `${row.name}: ${row.definition}`)
        .join("\n");
      expect(definitions).toContain("execution_ambiguous");
      expect(definitions).toContain("pending");
      expect(definitions).toContain("controller_device_id");
      expect(definitions).toContain("host_id");
      expect(definitions).toContain("pending");

      await client.query(`
        INSERT INTO organizations VALUES ('10000000-0000-4000-8000-000000000001');
        INSERT INTO users VALUES ('20000000-0000-4000-8000-000000000001');
        INSERT INTO remote_hosts (
          id, organization_id, user_id, device_id, display_name, platform,
          connection_mode, runtime_key_id, signing_public_jwk,
          encryption_public_jwk, host_token_hash, status
        ) VALUES (
          '40000000-0000-4000-8000-000000000001',
          '10000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000001',
          'device-one', 'Device One', 'linux', 'relay', 'runtime-key-one',
          '{}'::jsonb, '{}'::jsonb, 'host-token-hash', 'pending'
        );
      `);
      const pendingHost = await client.query<{ status: string; revoked_at: Date | null }>(`
        SELECT status, revoked_at FROM remote_hosts
        WHERE id = '40000000-0000-4000-8000-000000000001'
      `);
      expect(pendingHost.rows).toEqual([{ status: "pending", revoked_at: null }]);
      await expect(
        client.query(`
          UPDATE remote_hosts SET revoked_at = now()
          WHERE id = '40000000-0000-4000-8000-000000000001'
        `),
      ).rejects.toThrow();

      const retiredGateway = await client.query<{
        is_active: boolean;
        can_send_sms: boolean;
        can_receive_sms: boolean;
        can_send_imessage: boolean;
        can_receive_imessage: boolean;
      }>(`
        SELECT
          is_active,
          can_send_sms,
          can_receive_sms,
          can_send_imessage,
          can_receive_imessage
        FROM phone_gateway_devices
      `);
      expect(retiredGateway.rows).toEqual([
        {
          is_active: false,
          can_send_sms: false,
          can_receive_sms: false,
          can_send_imessage: false,
          can_receive_imessage: false,
        },
      ]);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  },
  120_000,
);
