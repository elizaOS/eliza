/** Replay and fail-closed envelope proofs for manifest-v3 migrations 0233 and 0234. */

import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const COLUMNS_MIGRATION = readFileSync(
  join(MIGRATIONS_DIR, "0233_agent_backup_catalog_manifest_v3_columns.sql"),
  "utf8",
);
const SHAPE_MIGRATION = readFileSync(
  join(MIGRATIONS_DIR, "0234_agent_backup_catalog_manifest_v3_shape.sql"),
  "utf8",
);
const OPERATION_ID = "00000000-0000-4000-8000-000000000001";
const KEY_GENERATION_ID = "00000000-0000-4000-8000-000000000002";
const VAULT_GENERATION_ID = "00000000-0000-4000-8000-000000000003";
const SHA = "a".repeat(64);
const KEY_BUNDLE_BASE64 = Buffer.alloc(92, 0x42).toString("base64");

async function legacyDatabase(): Promise<PGlite> {
  const database = new PGlite();
  await database.exec(`
    CREATE TABLE agent_sandbox_backups (
      id uuid PRIMARY KEY,
      backup_operation_id uuid,
      catalog_version integer,
      catalog_state text,
      catalog_resume_state text,
      manifest_format text,
      manifest_version integer,
      manifest_digest text,
      manifest_canonical_draft text,
      manifest_object_count integer,
      object_inventory_digest text,
      backup_image_digest text,
      database_schema_version text,
      plugin_set_digest text,
      watermark_digest text,
      raw_size_bytes bigint,
      compressed_size_bytes bigint,
      encrypted_size_bytes bigint,
      backup_kms_key_id text,
      backup_kms_key_version bigint,
      wrapped_dek_ref text,
      wrapped_dek_ciphertext_base64 text,
      wrapped_dek_sha256 text,
      wrapped_dek_size_bytes integer,
      wrapped_dek_receipt_digest text,
      CONSTRAINT agent_sandbox_backups_catalog_manifest_shape_check CHECK (true)
    );
  `);
  return database;
}

function commonCapturedValues(id: string, version: number, kmsVersion = "1"): string {
  return `
    '${id}', '${OPERATION_ID}', 2, 'captured', 'elizaos.agent-backup', ${version},
    '${SHA}', '{}', 1, '${SHA}', 'sha256:${SHA}', '1', '${SHA}', '${SHA}',
    64, 64, 92, 'org:00000000-0000-4000-8000-000000000004/dek/v1', ${kmsVersion}
  `;
}

const COMMON_COLUMNS = `
  id, backup_operation_id, catalog_version, catalog_state, manifest_format,
  manifest_version, manifest_digest, manifest_canonical_draft, manifest_object_count,
  object_inventory_digest, backup_image_digest, database_schema_version,
  plugin_set_digest, watermark_digest, raw_size_bytes, compressed_size_bytes,
  encrypted_size_bytes, backup_kms_key_id, backup_kms_key_version
`;

describe("0233/0234 agent backup catalogue manifest-v3 migrations", () => {
  test("replays while accepting exact v2, v3, and pre-capture shapes", async () => {
    const database = await legacyDatabase();
    try {
      await database.exec(COLUMNS_MIGRATION);
      await database.exec(SHAPE_MIGRATION);
      await database.exec(COLUMNS_MIGRATION);
      await database.exec(SHAPE_MIGRATION);
      await database.exec(`
        INSERT INTO agent_sandbox_backups (${COMMON_COLUMNS}, wrapped_dek_ref,
          wrapped_dek_ciphertext_base64, wrapped_dek_sha256, wrapped_dek_size_bytes,
          wrapped_dek_receipt_digest)
        VALUES (${commonCapturedValues("00000000-0000-4000-8000-000000000011", 2)},
          'backup-dek:${OPERATION_ID}', 'Qg==', '${SHA}', 1, '${SHA}');

        INSERT INTO agent_sandbox_backups (${COMMON_COLUMNS},
          operation_key_bundle_generation_id, operation_key_bundle_format,
          operation_key_bundle_ref, operation_key_bundle_ciphertext_base64,
          operation_key_bundle_sha256, operation_key_bundle_size_bytes,
          operation_key_bundle_context, operation_key_bundle_context_derivation,
          operation_key_bundle_local_receipt_derivation,
          operation_key_bundle_local_receipt_digest, vault_key_generation_id,
          vault_key_authority_receipt_digest)
        VALUES (${commonCapturedValues("00000000-0000-4000-8000-000000000012", 3)},
          '${KEY_GENERATION_ID}', 'kms-aead-operation-key-bundle-v1',
          'backup-key-bundle:${OPERATION_ID}', '${KEY_BUNDLE_BASE64}', '${SHA}', 92,
          '{"context":"exact"}', 'elizaos.agent-backup.operation-key-bundle-context.v1',
          'elizaos.kms-aead-operation-key-bundle.local-receipt.v1', '${SHA}',
          '${VAULT_GENERATION_ID}', '${SHA}');

        INSERT INTO agent_sandbox_backups (
          id, backup_operation_id, catalog_version, catalog_state
        ) VALUES ('00000000-0000-4000-8000-000000000013', '${OPERATION_ID}', 2, 'scheduled');
      `);

      const rows = await database.query<{ manifest_version: number | null }>(`
        SELECT manifest_version FROM agent_sandbox_backups ORDER BY id
      `);
      expect(rows.rows).toEqual([
        { manifest_version: 2 },
        { manifest_version: 3 },
        { manifest_version: null },
      ]);
      const constraint = await database.query<{ convalidated: boolean }>(`
        SELECT convalidated FROM pg_constraint
        WHERE conname = 'agent_sandbox_backups_catalog_manifest_shape_check'
      `);
      expect(constraint.rows).toEqual([{ convalidated: false }]);
      const plaintextColumns = await database.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'agent_sandbox_backups'
          AND column_name LIKE 'operation_key_bundle_plaintext%'
      `);
      expect(plaintextColumns.rows).toEqual([]);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("rejects unknown versions, partial envelopes, mixtures, and unsafe KMS versions", async () => {
    const database = await legacyDatabase();
    try {
      await database.exec(COLUMNS_MIGRATION);
      await database.exec(SHAPE_MIGRATION);
      const invalidStatements = [
        `INSERT INTO agent_sandbox_backups (${COMMON_COLUMNS}, wrapped_dek_ref,
          wrapped_dek_ciphertext_base64, wrapped_dek_sha256, wrapped_dek_size_bytes,
          wrapped_dek_receipt_digest)
        VALUES (${commonCapturedValues("00000000-0000-4000-8000-000000000021", 4)},
          'backup-dek:${OPERATION_ID}', 'Qg==', '${SHA}', 1, '${SHA}')`,
        `INSERT INTO agent_sandbox_backups (${COMMON_COLUMNS}, wrapped_dek_ref,
          wrapped_dek_ciphertext_base64, wrapped_dek_sha256, wrapped_dek_size_bytes,
          wrapped_dek_receipt_digest, operation_key_bundle_generation_id)
        VALUES (${commonCapturedValues("00000000-0000-4000-8000-000000000022", 2)},
          'backup-dek:${OPERATION_ID}', 'Qg==', '${SHA}', 1, '${SHA}',
          '${KEY_GENERATION_ID}')`,
        `INSERT INTO agent_sandbox_backups (${COMMON_COLUMNS}, wrapped_dek_ref,
          operation_key_bundle_generation_id, operation_key_bundle_format,
          operation_key_bundle_ref, operation_key_bundle_ciphertext_base64,
          operation_key_bundle_sha256, operation_key_bundle_size_bytes,
          operation_key_bundle_context, operation_key_bundle_context_derivation,
          operation_key_bundle_local_receipt_derivation,
          operation_key_bundle_local_receipt_digest, vault_key_generation_id,
          vault_key_authority_receipt_digest)
        VALUES (${commonCapturedValues("00000000-0000-4000-8000-000000000023", 3)},
          'mixed-v2-envelope', '${KEY_GENERATION_ID}', 'kms-aead-operation-key-bundle-v1',
          'backup-key-bundle:${OPERATION_ID}', '${KEY_BUNDLE_BASE64}', '${SHA}', 92, '{}',
          'elizaos.agent-backup.operation-key-bundle-context.v1',
          'elizaos.kms-aead-operation-key-bundle.local-receipt.v1', '${SHA}',
          '${VAULT_GENERATION_ID}', '${SHA}')`,
        `INSERT INTO agent_sandbox_backups (
          id, backup_operation_id, catalog_version, catalog_state, manifest_version
        ) VALUES ('00000000-0000-4000-8000-000000000024', '${OPERATION_ID}', 2,
          'scheduled', 3)`,
        `INSERT INTO agent_sandbox_backups (${COMMON_COLUMNS},
          operation_key_bundle_generation_id, operation_key_bundle_format,
          operation_key_bundle_ref, operation_key_bundle_ciphertext_base64,
          operation_key_bundle_sha256, operation_key_bundle_size_bytes,
          operation_key_bundle_context, operation_key_bundle_context_derivation,
          operation_key_bundle_local_receipt_derivation,
          operation_key_bundle_local_receipt_digest)
        VALUES (${commonCapturedValues("00000000-0000-4000-8000-000000000025", 3)},
          '${KEY_GENERATION_ID}', 'kms-aead-operation-key-bundle-v1',
          'backup-key-bundle:${OPERATION_ID}', '${KEY_BUNDLE_BASE64}', '${SHA}', 92, '{}',
          'elizaos.agent-backup.operation-key-bundle-context.v1',
          'elizaos.kms-aead-operation-key-bundle.local-receipt.v1', '${SHA}')`,
        `INSERT INTO agent_sandbox_backups (${COMMON_COLUMNS}, wrapped_dek_ref,
          wrapped_dek_ciphertext_base64, wrapped_dek_sha256, wrapped_dek_size_bytes,
          wrapped_dek_receipt_digest)
        VALUES (${commonCapturedValues(
          "00000000-0000-4000-8000-000000000026",
          2,
          "9007199254740992",
        )}, 'backup-dek:${OPERATION_ID}', 'Qg==', '${SHA}', 1, '${SHA}')`,
      ];
      for (const statement of invalidStatements) {
        await expect(database.exec(statement)).rejects.toThrow(
          /agent_sandbox_backups_catalog_manifest_shape_check/,
        );
      }
    } finally {
      await database.close();
    }
  }, 60_000);
});
