/** Applies the real 0218–0229 catalogue migrations to legacy rows in PGlite. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION_TAGS = [
  "0218_agent_backup_catalog_columns",
  "0219_agent_backup_catalog_legacy_backfill",
  "0220_agent_backup_catalog_authority",
  "0221_agent_backup_catalog_ownership_fks",
  "0222_agent_backup_catalog_identity_checks",
  "0223_agent_backup_catalog_runtime_checks",
  "0224_agent_backup_catalog_manifest_v2_check",
  "0225_agent_backup_catalog_indexes",
  "0226_agent_backup_objects",
  "0227_agent_backup_gc_outbox",
  "0228_agent_backup_catalog_tenant_authority",
  "0229_agent_backup_catalog_chain_authority",
] as const;
const ORG_ID = "00000000-0000-4000-8000-00000000d001";
const AGENT_ID = "00000000-0000-4000-8000-00000000d002";
const BACKUP_ID = "00000000-0000-4000-8000-00000000d003";
const V2_BACKUP_ID = "00000000-0000-4000-8000-00000000d004";
const FOREIGN_ORG_ID = "00000000-0000-4000-8000-00000000d006";
const FOREIGN_AGENT_ID = "00000000-0000-4000-8000-00000000d007";
const MISSING_BACKUP_ID = "00000000-0000-4000-8000-00000000d008";
const OBJECT_ID = "00000000-0000-4000-8000-00000000d009";

let database: PGlite;

async function applyMigrations(): Promise<void> {
  for (const tag of MIGRATION_TAGS) {
    await database.exec(readFileSync(join(import.meta.dir, `migrations/${tag}.sql`), "utf8"));
  }
}

beforeAll(async () => {
  database = new PGlite();
  await database.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE
    );
    CREATE TABLE agent_sandbox_backups (
      id uuid PRIMARY KEY,
      sandbox_record_id uuid REFERENCES agent_sandboxes(id) ON DELETE CASCADE,
      snapshot_type text NOT NULL,
      state_data jsonb NOT NULL,
      state_data_storage text NOT NULL DEFAULT 'inline',
      state_data_key text,
      size_bytes bigint,
      backup_kind text NOT NULL DEFAULT 'full',
      parent_backup_id uuid,
      content_hash text,
      verification_status text,
      verified_at timestamptz,
      verification_error text,
      recovery_organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
      recovery_agent_id uuid,
      recovery_deletion_attempt_id uuid,
      recovery_expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT NOW()
    );
    INSERT INTO organizations (id) VALUES ('${ORG_ID}');
    INSERT INTO agent_sandboxes (id, organization_id) VALUES ('${AGENT_ID}', '${ORG_ID}');
    INSERT INTO agent_sandbox_backups (
      id, sandbox_record_id, snapshot_type, state_data, backup_kind, content_hash
    ) VALUES (
      '${BACKUP_ID}', '${AGENT_ID}', 'auto',
      '{"memories":[],"config":{},"workspaceFiles":{}}', 'full', '${"a".repeat(64)}'
    );
  `);
});

afterAll(async () => {
  await database.close();
});

describe("0218–0229 agent backup catalogue migrations", () => {
  test("backfills durable identity and installs exact-object authority", async () => {
    await applyMigrations();

    const migrated = await database.query<{
      backup_operation_id: string;
      catalog_version: number;
      catalog_state: string;
      catalog_organization_id: string;
      catalog_agent_id: string;
      lifecycle_generation: string;
      lifecycle_revision: string;
    }>(`
      SELECT backup_operation_id, catalog_version, catalog_state,
        catalog_organization_id, catalog_agent_id, lifecycle_generation, lifecycle_revision
      FROM agent_sandbox_backups WHERE id = '${BACKUP_ID}'
    `);
    expect(migrated.rows).toEqual([
      {
        backup_operation_id: BACKUP_ID,
        catalog_version: 1,
        catalog_state: "legacy_unmigrated",
        catalog_organization_id: ORG_ID,
        catalog_agent_id: AGENT_ID,
        lifecycle_generation: BACKUP_ID,
        lifecycle_revision: "0",
      },
    ]);

    const tables = await database.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_name LIKE 'agent_backup_%' ORDER BY table_name
    `);
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "agent_backup_catalog_authorities",
      "agent_backup_gc_outbox",
      "agent_backup_objects",
    ]);
  }, 60_000);

  test("rejects NULL proof bypasses, attached tenant drift and nonexistent chains", async () => {
    await database.exec(`
      INSERT INTO agent_sandbox_backups (
        id, sandbox_record_id, snapshot_type, state_data, backup_kind,
        backup_operation_id, catalog_version, catalog_state, catalog_payload_digest,
        catalog_organization_id, catalog_agent_id, lifecycle_generation, lifecycle_revision,
        retention_reason, retention_until, manifest_format, manifest_version, manifest_digest,
        manifest_canonical_draft, manifest_object_count, object_inventory_digest,
        backup_image_digest, database_schema_version, plugin_set_digest, watermark_digest,
        raw_size_bytes, compressed_size_bytes, encrypted_size_bytes,
        backup_kms_key_id, backup_kms_key_version, wrapped_dek_ref,
        wrapped_dek_ciphertext_base64, wrapped_dek_sha256, wrapped_dek_size_bytes,
        wrapped_dek_receipt_digest, created_at
      ) VALUES (
        '${V2_BACKUP_ID}', '${AGENT_ID}', 'auto',
        '{"memories":[],"config":{},"workspaceFiles":{}}', 'full',
        '${V2_BACKUP_ID}', 2, 'captured', '${"b".repeat(64)}',
        '${ORG_ID}', '${AGENT_ID}', '${V2_BACKUP_ID}', 0,
        'schedule', NOW() + INTERVAL '30 days', 'elizaos.agent-backup', 2, '${"c".repeat(64)}',
        '{}', 1, '${"d".repeat(64)}', 'repo@sha256:${"e".repeat(64)}', '1',
        '${"f".repeat(64)}', '${"1".repeat(64)}', 1, 1, 1,
        'org:test/dek/v1', 1, 'wrapped-ref', 'AAAA', '${"2".repeat(64)}', 1,
        '${"3".repeat(64)}', NOW()
      );
    `);

    await database.exec(`UPDATE agent_sandbox_backups
      SET lifecycle_revision = 18446744073709551615
      WHERE id = '${V2_BACKUP_ID}'`);
    const uint64Revision = await database.query<{ lifecycle_revision: string }>(`
      SELECT lifecycle_revision::text AS lifecycle_revision
      FROM agent_sandbox_backups WHERE id = '${V2_BACKUP_ID}'
    `);
    expect(uint64Revision.rows).toEqual([{ lifecycle_revision: "18446744073709551615" }]);
    await expect(
      database.exec(`UPDATE agent_sandbox_backups
        SET lifecycle_revision = 18446744073709551616
        WHERE id = '${V2_BACKUP_ID}'`),
    ).rejects.toThrow();
    await database.exec(`UPDATE agent_sandbox_backups
      SET lifecycle_revision = 0 WHERE id = '${V2_BACKUP_ID}'`);
    await database.exec(`UPDATE agent_sandbox_backups
      SET backup_kms_key_version = 9007199254740991
      WHERE id = '${V2_BACKUP_ID}'`);
    const safeKmsVersion = await database.query<{ backup_kms_key_version: string }>(`
      SELECT backup_kms_key_version::text AS backup_kms_key_version
      FROM agent_sandbox_backups WHERE id = '${V2_BACKUP_ID}'
    `);
    expect(safeKmsVersion.rows).toEqual([{ backup_kms_key_version: "9007199254740991" }]);
    await expect(
      database.exec(`UPDATE agent_sandbox_backups
        SET backup_kms_key_version = 9007199254740992
        WHERE id = '${V2_BACKUP_ID}'`),
    ).rejects.toThrow();
    await database.exec(`UPDATE agent_sandbox_backups
      SET backup_kms_key_version = 1 WHERE id = '${V2_BACKUP_ID}'`);

    await expect(
      database.exec(
        `UPDATE agent_sandbox_backups SET manifest_digest = NULL WHERE id = '${V2_BACKUP_ID}'`,
      ),
    ).rejects.toThrow();
    await expect(
      database.exec(
        `UPDATE agent_sandbox_backups SET catalog_state = 'restore_verified' WHERE id = '${V2_BACKUP_ID}'`,
      ),
    ).rejects.toThrow();
    await expect(
      database.exec(
        `UPDATE agent_sandbox_backups SET catalog_state = 'deleted' WHERE id = '${V2_BACKUP_ID}'`,
      ),
    ).rejects.toThrow();
    await expect(
      database.exec(`
        INSERT INTO agent_backup_objects (
          organization_id, backup_id, copy_role, component, chunk_index, state,
          transport, provider, endpoint_alias, endpoint_identity_fingerprint,
          bucket, region, object_key, key_fingerprint, content_hmac_sha256,
          ciphertext_sha256, size_bytes, verified_at
        ) VALUES (
          '${ORG_ID}', '${V2_BACKUP_ID}', 'primary', 'database', 0, 'verified',
          'worker-r2', 'cloudflare-r2', 'primary', 'sha256:${"4".repeat(64)}',
          'bucket', 'auto', 'key', '${"5".repeat(64)}', '${"6".repeat(64)}',
          '${"7".repeat(64)}', 1, NOW()
        )
      `),
    ).rejects.toThrow();
    await database.exec(`
      INSERT INTO agent_backup_objects (
        id, organization_id, backup_id, copy_role, component, chunk_index, state,
        transport, provider, endpoint_alias, endpoint_identity_fingerprint,
        bucket, region, object_key, key_fingerprint, content_hmac_sha256,
        ciphertext_sha256, size_bytes
      ) VALUES (
        '${OBJECT_ID}', '${ORG_ID}', '${V2_BACKUP_ID}', 'primary', 'database', 0, 'reserved',
        'worker-r2', 'cloudflare-r2', 'primary', 'sha256:${"4".repeat(64)}',
        'bucket', 'auto', 'key', '${"5".repeat(64)}', '${"6".repeat(64)}',
        '${"7".repeat(64)}', 1
      )
    `);
    await expect(
      database.exec(`UPDATE agent_backup_objects SET
        state = 'present', provider_write_started = TRUE, provider_etag = '',
        upload_receipt_digest = '${"8".repeat(64)}'
        WHERE id = '${OBJECT_ID}'`),
    ).rejects.toThrow();
    await expect(
      database.exec(`INSERT INTO agent_backup_gc_outbox (
        organization_id, object_id, action, expected_locator_digest,
        expected_key_fingerprint, last_failure_generation
      ) VALUES (
        '${ORG_ID}', '${OBJECT_ID}', 'delete_object', '${"9".repeat(64)}',
        '${"5".repeat(64)}', '${OBJECT_ID}'
      )`),
    ).rejects.toThrow();

    await database.exec(`
      INSERT INTO organizations (id) VALUES ('${FOREIGN_ORG_ID}');
      INSERT INTO agent_backup_catalog_authorities (organization_id, agent_id)
      VALUES ('${FOREIGN_ORG_ID}', '${AGENT_ID}'), ('${ORG_ID}', '${FOREIGN_AGENT_ID}');
    `);
    await expect(
      database.exec(
        `UPDATE agent_sandbox_backups SET catalog_organization_id = '${FOREIGN_ORG_ID}' WHERE id = '${V2_BACKUP_ID}'`,
      ),
    ).rejects.toThrow();
    await expect(
      database.exec(
        `UPDATE agent_sandbox_backups SET catalog_agent_id = '${FOREIGN_AGENT_ID}' WHERE id = '${V2_BACKUP_ID}'`,
      ),
    ).rejects.toThrow();
    await expect(
      database.exec(`UPDATE agent_sandbox_backups SET backup_kind = 'incremental',
        parent_backup_id = '${MISSING_BACKUP_ID}', base_backup_id = '${MISSING_BACKUP_ID}'
        WHERE id = '${V2_BACKUP_ID}'`),
    ).rejects.toThrow();

    const unchanged = await database.query<{
      catalog_organization_id: string;
      catalog_agent_id: string;
      catalog_state: string;
      manifest_digest: string;
    }>(`SELECT catalog_organization_id, catalog_agent_id, catalog_state, manifest_digest
        FROM agent_sandbox_backups WHERE id = '${V2_BACKUP_ID}'`);
    expect(unchanged.rows).toEqual([
      {
        catalog_organization_id: ORG_ID,
        catalog_agent_id: AGENT_ID,
        catalog_state: "captured",
        manifest_digest: "c".repeat(64),
      },
    ]);

    await database.exec(`
      DELETE FROM agent_backup_objects WHERE id = '${OBJECT_ID}';
      DELETE FROM agent_sandbox_backups WHERE id = '${V2_BACKUP_ID}';
      DELETE FROM agent_backup_catalog_authorities
        WHERE organization_id = '${FOREIGN_ORG_ID}' OR agent_id = '${FOREIGN_AGENT_ID}';
      DELETE FROM organizations WHERE id = '${FOREIGN_ORG_ID}';
    `);
  }, 60_000);

  test("blocks v2 authority loss, cascades legacy rows and replays exactly", async () => {
    await database.exec(`
      INSERT INTO agent_sandbox_backups (
        id, sandbox_record_id, snapshot_type, state_data, backup_kind,
        backup_operation_id, catalog_version, catalog_state, catalog_payload_digest,
        catalog_organization_id, catalog_agent_id, lifecycle_generation, lifecycle_revision,
        retention_reason, retention_until, created_at
      ) VALUES (
        '${V2_BACKUP_ID}', '${AGENT_ID}', 'auto',
        '{"memories":[],"config":{},"workspaceFiles":{}}', 'full',
        '${V2_BACKUP_ID}', 2, 'scheduled', '${"b".repeat(64)}',
        '${ORG_ID}', '${AGENT_ID}', '${V2_BACKUP_ID}', 0,
        'schedule', NOW() + INTERVAL '30 days', NOW()
      );
    `);
    await expect(
      database.exec(`DELETE FROM agent_sandboxes WHERE id = '${AGENT_ID}'`),
    ).rejects.toThrow(/still owns backup catalog v2 authority/);
    const blocked = await database.query<{
      id: string;
      sandbox_record_id: string;
      catalog_agent_id: string;
      catalog_version: number;
      catalog_state: string;
    }>(`SELECT id, sandbox_record_id, catalog_agent_id, catalog_version, catalog_state
        FROM agent_sandbox_backups ORDER BY id`);
    expect(blocked.rows).toEqual([
      {
        id: BACKUP_ID,
        sandbox_record_id: AGENT_ID,
        catalog_agent_id: AGENT_ID,
        catalog_version: 1,
        catalog_state: "legacy_unmigrated",
      },
      {
        id: V2_BACKUP_ID,
        sandbox_record_id: AGENT_ID,
        catalog_agent_id: AGENT_ID,
        catalog_version: 2,
        catalog_state: "scheduled",
      },
    ]);

    await database.exec(`DELETE FROM agent_sandbox_backups WHERE id = '${V2_BACKUP_ID}'`);
    await database.exec(`DELETE FROM agent_sandboxes WHERE id = '${AGENT_ID}'`);

    await applyMigrations();
    const counts = await database.query<{ backups: number; authorities: number }>(`
      SELECT
        (SELECT count(*)::int FROM agent_sandbox_backups) AS backups,
        (SELECT count(*)::int FROM agent_backup_catalog_authorities) AS authorities
    `);
    expect(counts.rows).toEqual([{ backups: 0, authorities: 1 }]);
  }, 60_000);
});
