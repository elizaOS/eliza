/**
 * Replays the secure remote relay migrations on real PGlite and proves their
 * target, authority, uniqueness, and post-start lifecycle constraints.
 */

import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migrations = [
  "0068_add_remote_sessions",
  "0275_remote_sessions_first_class_expiry",
  "0305_secure_remote_hosts",
  "0306_secure_remote_command_relay",
] as const;

async function apply(database: PGlite, name: string): Promise<void> {
  const source = await readFile(new URL(`./migrations/${name}.sql`, import.meta.url), "utf8");
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
}

describe("secure remote relay migrations", () => {
  it("enforces one target, immutable authority shape, and durable start evidence", async () => {
    const database = new PGlite();
    try {
      await database.exec(`
        CREATE TABLE organizations (id uuid PRIMARY KEY);
        CREATE TABLE users (id uuid PRIMARY KEY);
        CREATE TABLE eliza_sandboxes (id uuid PRIMARY KEY);
        INSERT INTO organizations VALUES ('10000000-0000-4000-8000-000000000001');
        INSERT INTO users VALUES ('20000000-0000-4000-8000-000000000001');
        INSERT INTO eliza_sandboxes VALUES ('30000000-0000-4000-8000-000000000001');
      `);
      for (const migration of migrations) await apply(database, migration);

      await database.exec(`
        INSERT INTO remote_hosts (
          id, organization_id, user_id, device_id, display_name, platform,
          connection_mode, runtime_key_id, signing_public_jwk,
          encryption_public_jwk, host_token_hash
        ) VALUES (
          '40000000-0000-4000-8000-000000000001',
          '10000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000001',
          'linux-one', 'Linux One', 'linux', 'relay', 'target-key-1',
          '{"kty":"EC"}', '{"kty":"EC"}', 'sha256:token'
        );
        INSERT INTO remote_sessions (
          id, organization_id, user_id, host_id, grant_id, grant_revision,
          status, requester_identity, controller_device_id, controller_key_id,
          controller_signing_public_jwk, controller_encryption_public_jwk,
          target_key_id, expires_at, grant_expires_at
        ) VALUES (
          '50000000-0000-4000-8000-000000000001',
          '10000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000001',
          '40000000-0000-4000-8000-000000000001',
          '60000000-0000-4000-8000-000000000001', 1, 'active',
          '20000000-0000-4000-8000-000000000001', 'controller-one',
          'controller-key-1', '{"kty":"EC"}', '{"kty":"EC"}',
          'target-key-1', now() + interval '5 minutes', now() + interval '1 hour'
        );
        INSERT INTO remote_command_envelopes (
          id, session_id, grant_id, grant_revision, organization_id, user_id,
          host_id, controller_device_id, controller_key_id, target_key_id,
          command_id, sequence, nonce, envelope, status, attempts, claim_token,
          start_receipt, started_at, expires_at
        ) VALUES (
          '70000000-0000-4000-8000-000000000001',
          '50000000-0000-4000-8000-000000000001',
          '60000000-0000-4000-8000-000000000001', 1,
          '10000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000001',
          '40000000-0000-4000-8000-000000000001', 'controller-one',
          'controller-key-1', 'target-key-1', 'command-one', 1, 'nonce-one',
          '{}', 'started', 1, '80000000-0000-4000-8000-000000000001',
          '{}', now(), now() + interval '1 minute'
        );
      `);

      await expect(
        database.exec(`
          INSERT INTO remote_sessions (
            organization_id, user_id, agent_id, host_id, status, requester_identity
          ) VALUES (
            '10000000-0000-4000-8000-000000000001',
            '20000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000001',
            '40000000-0000-4000-8000-000000000001', 'pending', 'owner'
          )
        `),
      ).rejects.toThrow(/exactly_one_target/i);
      await expect(
        database.exec(`
          UPDATE remote_command_envelopes
          SET status = 'pending', claim_token = NULL
          WHERE id = '70000000-0000-4000-8000-000000000001'
        `),
      ).rejects.toThrow(/lifecycle_shape/i);
      await expect(
        database.exec(`
          INSERT INTO remote_command_envelopes (
            session_id, grant_id, grant_revision, organization_id, user_id,
            host_id, controller_device_id, controller_key_id, target_key_id,
            command_id, sequence, nonce, envelope, expires_at
          ) SELECT session_id, grant_id, grant_revision, organization_id, user_id,
            host_id, controller_device_id, controller_key_id, target_key_id,
            'command-two', sequence, 'nonce-two', envelope, expires_at
          FROM remote_command_envelopes
          WHERE id = '70000000-0000-4000-8000-000000000001'
        `),
      ).rejects.toThrow(/session_sequence_unique/i);

      const journal = JSON.parse(
        await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"),
      ) as { entries: Array<{ idx: number; tag: string; when: number }> };
      const relayEntries = journal.entries.slice(-8);
      expect(relayEntries.map((entry) => entry.tag)).toEqual([
        "0304_personal_shared_group_delivery_lease",
        "0305_secure_remote_hosts",
        "0306_secure_remote_command_relay",
        "0307_twilio_outbound_call_audit",
        "0308_remove_conversation_token_default",
        "0309_retire_legacy_bluebubbles_gateways",
        "0310_personal_shared_inbound_media_admission",
        "0311_remote_host_managed_network",
      ]);
      expect(relayEntries.map((entry) => entry.idx)).toEqual([
        287, 288, 289, 290, 291, 292, 293, 294,
      ]);
      for (let index = 1; index < relayEntries.length; index += 1) {
        expect(relayEntries[index]!.when).toBeGreaterThan(relayEntries[index - 1]!.when);
      }
      expect(new Set(journal.entries.map((entry) => entry.when)).size).toBe(journal.entries.length);
    } finally {
      await database.close();
    }
  });
});
