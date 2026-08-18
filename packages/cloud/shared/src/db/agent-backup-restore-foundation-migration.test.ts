/** Replay and raw-SQL authority proofs for restore-foundation migrations 0237-0245. */

import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const MIGRATION_NAMES = [
  "0237_agent_restore_authority_prerequisites",
  "0238_agent_backup_restore_lease_core",
  "0239_agent_backup_restore_lease_authority",
  "0240_agent_vault_key_generations",
  "0241_agent_vault_key_current_authority",
  "0242_agent_vault_key_backup_bindings",
  "0243_agent_backup_catalog_authority_guard",
  "0244_agent_backup_restore_lease_guard",
  "0245_agent_vault_key_topology_guard",
] as const;
const MIGRATIONS = MIGRATION_NAMES.map((name) =>
  readFileSync(join(MIGRATIONS_DIR, `${name}.sql`), "utf8"),
);

const ORG_ID = "00000000-0000-4000-8000-00000000f001";
const AGENT_ID = "00000000-0000-4000-8000-00000000f002";
const BACKUP_ID = "00000000-0000-4000-8000-00000000f003";
const OPERATION_ID = "00000000-0000-4000-8000-00000000f004";
const SOURCE_GENERATION = "00000000-0000-4000-8000-00000000f005";
const VAULT_ROOT = "00000000-0000-4000-8000-00000000f006";
const RESTORE_ATTEMPT = "00000000-0000-4000-8000-00000000f007";
const LEASE_ID = "00000000-0000-4000-8000-00000000f008";
const FENCE = "00000000-0000-4000-8000-00000000f009";
const VAULT_SUCCESSOR = "00000000-0000-4000-8000-00000000f010";
const VAULT_GRANDCHILD = "00000000-0000-4000-8000-00000000f011";
const VAULT_CYCLE_A = "00000000-0000-4000-8000-00000000f012";
const VAULT_CYCLE_B = "00000000-0000-4000-8000-00000000f013";
const VAULT_CYCLE_C = "00000000-0000-4000-8000-00000000f014";
const UINT64_MAX = "18446744073709551615";
const SHA = "a".repeat(64);
const RECEIPT_SHA = "b".repeat(64);

async function prerequisiteDatabase(): Promise<PGlite> {
  const database = new PGlite();
  await database.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE agent_backup_catalog_authorities (
      organization_id uuid NOT NULL REFERENCES organizations(id),
      agent_id uuid NOT NULL,
      catalog_revision bigint NOT NULL DEFAULT 0,
      restore_generation bigint NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      PRIMARY KEY (organization_id, agent_id)
    );
    CREATE TABLE agent_sandbox_backups (
      id uuid PRIMARY KEY,
      catalog_organization_id uuid NOT NULL REFERENCES organizations(id),
      catalog_agent_id uuid NOT NULL,
      backup_operation_id uuid NOT NULL,
      lifecycle_generation uuid NOT NULL,
      lifecycle_revision numeric(20, 0) NOT NULL,
      manifest_digest text NOT NULL,
      manifest_version integer,
      catalog_state text,
      vault_key_generation_id uuid,
      vault_key_authority_receipt_digest text,
      UNIQUE (id, catalog_organization_id, catalog_agent_id)
    );
    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      activation_backup_id uuid,
      activation_consent_head_backup_id uuid
    );
    INSERT INTO organizations VALUES ('${ORG_ID}');
    INSERT INTO agent_backup_catalog_authorities
      (organization_id, agent_id, catalog_revision, restore_generation)
      VALUES ('${ORG_ID}', '${AGENT_ID}', 9, 4);
    INSERT INTO agent_sandbox_backups (
      id, catalog_organization_id, catalog_agent_id, backup_operation_id,
      lifecycle_generation, lifecycle_revision, manifest_digest, manifest_version,
      catalog_state, vault_key_generation_id, vault_key_authority_receipt_digest
    ) VALUES (
      '${BACKUP_ID}', '${ORG_ID}', '${AGENT_ID}', '${OPERATION_ID}',
      '${SOURCE_GENERATION}', ${UINT64_MAX}, '${SHA}', 3, 'protected',
      '${VAULT_ROOT}', '${RECEIPT_SHA}'
    );
  `);
  return database;
}

async function applyMigrations(database: PGlite): Promise<void> {
  for (const migration of MIGRATIONS) await database.exec(migration);
}

function generationInsert(
  input: {
    generationId: string;
    supersedes?: string | null;
    kmsKeyId?: string;
    kmsVersion?: string;
  },
  ...additional: Array<{
    generationId: string;
    supersedes?: string | null;
    kmsKeyId?: string;
    kmsVersion?: string;
  }>
): string {
  const values = [input, ...additional]
    .map(
      (generation) => `(
    '${ORG_ID}', '${AGENT_ID}', '${generation.generationId}', '${SOURCE_GENERATION}',
    ${generation.supersedes ? `'${generation.supersedes}'` : "NULL"},
    'kms-aead-vault-passphrase-v1', '${generation.kmsKeyId ?? `org:${ORG_ID}/dek/v1`}',
    ${generation.kmsVersion ?? "1"}, '{}', 'elizaos.agent-vault-key.kms-context.v1',
    '${Buffer.alloc(32, 0x11).toString("base64")}',
    '${Buffer.alloc(12, 0x22).toString("base64")}',
    '${Buffer.alloc(16, 0x33).toString("base64")}', '${SHA}',
    'elizaos.agent-vault-key.authority-receipt.v1', '${RECEIPT_SHA}'
  )`,
    )
    .join(", ");
  return `INSERT INTO agent_vault_key_generations (
    organization_id, agent_id, generation_id, source_activation_generation,
    supersedes_generation_id, format, kms_key_id, kms_key_version, kms_context,
    kms_context_derivation, wrapped_ciphertext_base64, wrapped_nonce_base64,
    wrapped_auth_tag_base64, wrapped_envelope_sha256,
    authority_receipt_derivation, authority_receipt_digest
  ) VALUES ${values}`;
}

function atomicRootAuthorityInsert(): string {
  return `BEGIN;
    ${generationInsert({ generationId: VAULT_ROOT })};
    INSERT INTO agent_vault_key_authorities
      (organization_id, agent_id, current_generation_id)
      VALUES ('${ORG_ID}', '${AGENT_ID}', '${VAULT_ROOT}');
    COMMIT`;
}

function bindingInsert(vaultGenerationId = VAULT_ROOT): string {
  return `INSERT INTO agent_vault_key_backup_bindings (
    organization_id, agent_id, backup_id, operation_id, source_activation_generation,
    source_lifecycle_revision, manifest_sha256, vault_key_generation_id,
    vault_key_authority_receipt_digest
  ) VALUES (
    '${ORG_ID}', '${AGENT_ID}', '${BACKUP_ID}', '${OPERATION_ID}', '${SOURCE_GENERATION}',
    ${UINT64_MAX}, '${SHA}', '${vaultGenerationId}', '${RECEIPT_SHA}'
  )`;
}

function leaseInsert(
  input: {
    leaseId?: string;
    attemptId?: string;
    owner?: string;
    catalogEpoch?: number;
    ttl?: string;
  } = {},
): string {
  return `INSERT INTO agent_backup_restore_leases (
    id, organization_id, agent_id, backup_id, operation_id, activation_generation,
    lifecycle_revision, expected_manifest_sha256, copy_role, restore_attempt_id, owner_id,
    generation, catalog_epoch, expires_at, created_at
  ) SELECT
    '${input.leaseId ?? LEASE_ID}', '${ORG_ID}', '${AGENT_ID}', '${BACKUP_ID}', '${OPERATION_ID}',
    '${SOURCE_GENERATION}', ${UINT64_MAX}, '${SHA}', 'primary',
    '${input.attemptId ?? RESTORE_ATTEMPT}', '${input.owner ?? "restore-owner"}', '${FENCE}',
    ${input.catalogEpoch ?? 9}, db_now + INTERVAL '${input.ttl ?? "10 minutes"}', db_now
  FROM (SELECT clock_timestamp() AS db_now) AS clock`;
}

describe("0237-0245 restore and vault foundation migrations", () => {
  test("installs activation backup tenant FKs with deferred validation", () => {
    const prerequisites = MIGRATIONS[0];
    expect(prerequisites.match(/ON DELETE RESTRICT NOT VALID;/g)).toHaveLength(2);
    expect(prerequisites.match(/ALTER TABLE "agent_sandboxes" VALIDATE CONSTRAINT/g)).toHaveLength(
      2,
    );
  });

  test("captures raw-renewal database time only after both reproof locks", () => {
    const guard = MIGRATIONS[MIGRATION_NAMES.indexOf("0244_agent_backup_restore_lease_guard")];
    expect(guard).toBeDefined();
    const renewal = guard!.slice(guard!.indexOf("IF (to_jsonb(NEW)"));
    const backupLock = renewal.indexOf("FOR NO KEY UPDATE OF backup NOWAIT");
    const authorityLock = renewal.indexOf("FOR NO KEY UPDATE NOWAIT");
    const databaseClock = renewal.indexOf("db_now := clock_timestamp()");
    expect(backupLock).toBeGreaterThanOrEqual(0);
    expect(authorityLock).toBeGreaterThan(backupLock);
    expect(databaseClock).toBeGreaterThan(authorityLock);
  });

  test("replays, preserves uint64 exactly, and never fabricates authority", async () => {
    const database = await prerequisiteDatabase();
    try {
      await applyMigrations(database);
      await applyMigrations(database);
      const proof = await database.query<{
        bindings: number;
        leases: number;
        lifecycle_revision: string;
        guard_triggers: number;
        truncate_triggers: number;
      }>(`SELECT
        (SELECT count(*)::int FROM agent_vault_key_backup_bindings) AS bindings,
        (SELECT count(*)::int FROM agent_backup_restore_leases) AS leases,
        lifecycle_revision::text,
        (SELECT count(*)::int FROM pg_trigger WHERE tgname IN (
          'agent_backup_catalog_authority_guard', 'agent_backup_restore_lease_guard',
          'agent_vault_key_authority_guard', 'agent_vault_key_generation_insert_guard',
          'agent_vault_key_generation_tip_guard')) AS guard_triggers
        , (SELECT count(*)::int FROM pg_trigger WHERE tgname IN (
          'agent_vault_key_generations_truncate_guard',
          'agent_vault_key_authorities_truncate_guard',
          'agent_vault_key_backup_bindings_truncate_guard',
          'agent_backup_restore_leases_truncate_guard',
          'agent_backup_catalog_authority_truncate_guard')) AS truncate_triggers
        FROM agent_sandbox_backups WHERE id = '${BACKUP_ID}'`);
      expect(proof.rows).toEqual([
        {
          bindings: 0,
          leases: 0,
          lifecycle_revision: UINT64_MAX,
          guard_triggers: 5,
          truncate_triggers: 5,
        },
      ]);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("rejects dangling and cross-tenant activation backup references", async () => {
    const database = await prerequisiteDatabase();
    try {
      const ORG_B = "00000000-0000-4000-8000-00000000f0b1";
      const FOREIGN_BACKUP = "00000000-0000-4000-8000-00000000f0b2";
      const OTHER_AGENT_BACKUP = "00000000-0000-4000-8000-00000000f0b3";
      const OTHER_AGENT = "00000000-0000-4000-8000-00000000f0b4";
      await database.exec(`
        INSERT INTO organizations VALUES ('${ORG_B}');
        INSERT INTO agent_backup_catalog_authorities (organization_id, agent_id)
          VALUES ('${ORG_B}', '${AGENT_ID}'), ('${ORG_ID}', '${OTHER_AGENT}');
        INSERT INTO agent_sandbox_backups (
          id, catalog_organization_id, catalog_agent_id, backup_operation_id,
          lifecycle_generation, lifecycle_revision, manifest_digest
        ) VALUES
          ('${FOREIGN_BACKUP}', '${ORG_B}', '${AGENT_ID}', '${OPERATION_ID}',
            '${SOURCE_GENERATION}', 1, '${SHA}'),
          ('${OTHER_AGENT_BACKUP}', '${ORG_ID}', '${OTHER_AGENT}', '${OPERATION_ID}',
            '${SOURCE_GENERATION}', 1, '${SHA}');
      `);
      await applyMigrations(database);
      await expect(
        database.exec(`INSERT INTO agent_sandboxes (id, organization_id, activation_backup_id)
          VALUES ('${AGENT_ID}', '${ORG_ID}', '00000000-0000-4000-8000-00000000dead')`),
      ).rejects.toThrow(/agent_sandboxes_activation_backup_authority_fkey/);
      await expect(
        database.exec(`INSERT INTO agent_sandboxes (id, organization_id, activation_backup_id)
          VALUES ('${AGENT_ID}', '${ORG_ID}', '${FOREIGN_BACKUP}')`),
      ).rejects.toThrow(/agent_sandboxes_activation_backup_authority_fkey/);
      await expect(
        database.exec(`INSERT INTO agent_sandboxes (id, organization_id, activation_backup_id)
          VALUES ('${AGENT_ID}', '${ORG_ID}', '${OTHER_AGENT_BACKUP}')`),
      ).rejects.toThrow(/agent_sandboxes_activation_backup_authority_fkey/);
      await expect(
        database.exec(`INSERT INTO agent_sandboxes (
            id, organization_id, activation_consent_head_backup_id
          ) VALUES ('${AGENT_ID}', '${ORG_ID}', '${FOREIGN_BACKUP}')`),
      ).rejects.toThrow(/agent_sandboxes_activation_consent_backup_authority_fkey/);
      await database.exec(`INSERT INTO agent_sandboxes (
          id, organization_id, activation_backup_id, activation_consent_head_backup_id
        ) VALUES ('${AGENT_ID}', '${ORG_ID}', '${BACKUP_ID}', '${BACKUP_ID}')`);
      await expect(
        database.exec(`DELETE FROM agent_sandbox_backups WHERE id = '${BACKUP_ID}'`),
      ).rejects.toThrow(/violates foreign key constraint/);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("rejects a disconnected cycle already present when the topology guard is installed", async () => {
    const database = await prerequisiteDatabase();
    try {
      for (const migration of MIGRATIONS.slice(0, -1)) await database.exec(migration);
      await database.exec(generationInsert({ generationId: VAULT_ROOT }));
      await database.exec(`INSERT INTO agent_vault_key_authorities
        (organization_id, agent_id, current_generation_id)
        VALUES ('${ORG_ID}', '${AGENT_ID}', '${VAULT_ROOT}')`);
      await database.exec(
        generationInsert(
          { generationId: VAULT_CYCLE_A, supersedes: VAULT_CYCLE_B },
          { generationId: VAULT_CYCLE_B, supersedes: VAULT_CYCLE_A },
        ),
      );
      await expect(database.exec(MIGRATIONS[MIGRATIONS.length - 1]!)).rejects.toThrow(
        /not one connected acyclic/,
      );
    } finally {
      await database.close();
    }
  }, 60_000);

  test("rejects a pre-existing vault generation without a current authority", async () => {
    const database = await prerequisiteDatabase();
    try {
      for (const migration of MIGRATIONS.slice(0, -1)) await database.exec(migration);
      await database.exec(generationInsert({ generationId: VAULT_ROOT }));
      await expect(database.exec(MIGRATIONS[MIGRATIONS.length - 1]!)).rejects.toThrow(
        /current-tipped chain/,
      );
    } finally {
      await database.close();
    }
  }, 60_000);

  test("rejects a pre-existing successor beyond the committed current pointer", async () => {
    const database = await prerequisiteDatabase();
    try {
      for (const migration of MIGRATIONS.slice(0, -1)) await database.exec(migration);
      await database.exec(generationInsert({ generationId: VAULT_ROOT }));
      await database.exec(`INSERT INTO agent_vault_key_authorities
        (organization_id, agent_id, current_generation_id)
        VALUES ('${ORG_ID}', '${AGENT_ID}', '${VAULT_ROOT}')`);
      await database.exec(
        generationInsert({ generationId: VAULT_SUCCESSOR, supersedes: VAULT_ROOT }),
      );
      await expect(database.exec(MIGRATIONS[MIGRATIONS.length - 1]!)).rejects.toThrow(
        /current-tipped chain/,
      );
    } finally {
      await database.close();
    }
  }, 60_000);

  test("rejects catalogue rewind/delete and every forged lease lifecycle", async () => {
    const database = await prerequisiteDatabase();
    try {
      await applyMigrations(database);
      await database.exec(atomicRootAuthorityInsert());
      await database.exec(bindingInsert());

      await expect(
        database.exec(`UPDATE agent_backup_catalog_authorities SET catalog_revision = 8
          WHERE organization_id = '${ORG_ID}' AND agent_id = '${AGENT_ID}'`),
      ).rejects.toThrow(/cannot change identity or rewind/);
      await expect(
        database.exec(`UPDATE agent_backup_catalog_authorities SET restore_generation = 3
          WHERE organization_id = '${ORG_ID}' AND agent_id = '${AGENT_ID}'`),
      ).rejects.toThrow(/cannot change identity or rewind/);
      await expect(
        database.exec(`DELETE FROM agent_backup_catalog_authorities
          WHERE organization_id = '${ORG_ID}' AND agent_id = '${AGENT_ID}'`),
      ).rejects.toThrow(/cannot be deleted/);
      await database.exec(`UPDATE agent_backup_catalog_authorities
        SET catalog_revision = 10, updated_at = '2000-01-01T00:00:00Z'
        WHERE organization_id = '${ORG_ID}' AND agent_id = '${AGENT_ID}'`);
      const stamped = await database.query<{ revision: string; db_stamped: boolean }>(`SELECT
        catalog_revision::text AS revision, updated_at > '2026-01-01' AS db_stamped
        FROM agent_backup_catalog_authorities WHERE organization_id = '${ORG_ID}'`);
      expect(stamped.rows).toEqual([{ revision: "10", db_stamped: true }]);

      await expect(database.exec(leaseInsert({ catalogEpoch: 9 }))).rejects.toThrow(
        /catalogue epoch is stale/,
      );
      await expect(
        database.exec(leaseInsert({ catalogEpoch: 10, ttl: "61 minutes" })),
      ).rejects.toThrow(/invalid bounded lifecycle/);
      await database.exec(leaseInsert({ catalogEpoch: 10, ttl: "20 milliseconds" }));
      await expect(
        database.exec(`UPDATE agent_backup_restore_leases SET owner_id = 'forged-owner'
          WHERE id = '${LEASE_ID}'`),
      ).rejects.toThrow(/immutable authority/);
      await expect(
        database.exec(`INSERT INTO agent_backup_restore_leases (
          id, organization_id, agent_id, backup_id, operation_id, activation_generation,
          lifecycle_revision, expected_manifest_sha256, copy_role, restore_attempt_id, owner_id,
          generation, catalog_epoch, expires_at, created_at
        ) SELECT '00000000-0000-4000-8000-00000000f020', '${ORG_ID}', '${AGENT_ID}',
          '${BACKUP_ID}', '${OPERATION_ID}', '${SOURCE_GENERATION}', ${UINT64_MAX}, '${SHA}',
          'secondary', '00000000-0000-4000-8000-00000000f021', 'other-owner',
          '00000000-0000-4000-8000-00000000f022', 10, db_now + INTERVAL '1 minute', db_now
          FROM (SELECT clock_timestamp() AS db_now) AS clock`),
      ).rejects.toThrow(/one_unreleased_uidx/);
      await database.exec("SELECT pg_sleep(0.04)");
      await expect(
        database.exec(`UPDATE agent_backup_restore_leases
          SET expires_at = clock_timestamp() + INTERVAL '1 minute' WHERE id = '${LEASE_ID}'`),
      ).rejects.toThrow(/must be live, monotone, and bounded/);
      await database.exec(`UPDATE agent_backup_restore_leases SET released_at = clock_timestamp()
        WHERE id = '${LEASE_ID}'`);
      await expect(
        database.exec(`UPDATE agent_backup_restore_leases SET released_at = NULL
          WHERE id = '${LEASE_ID}'`),
      ).rejects.toThrow(/immutable authority/);
      await expect(
        database.exec(`DELETE FROM agent_backup_restore_leases WHERE id = '${LEASE_ID}'`),
      ).rejects.toThrow(/cannot be deleted/);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("DB-stamps lease lifetime after a delayed transaction starts", async () => {
    const database = await prerequisiteDatabase();
    try {
      await applyMigrations(database);
      await database.exec(atomicRootAuthorityInsert());
      await database.exec(bindingInsert());
      await database.exec("BEGIN");
      const started = await database.query<{ started_at: Date }>(
        "SELECT transaction_timestamp() AS started_at",
      );
      await database.exec("SELECT pg_sleep(0.04)");
      await database.exec(leaseInsert());
      const inserted = await database.query<{ created_at: Date; expires_at: Date }>(`
        SELECT created_at, expires_at FROM agent_backup_restore_leases WHERE id = '${LEASE_ID}'
      `);
      await database.exec("COMMIT");
      expect(
        inserted.rows[0]!.created_at.getTime() - started.rows[0]!.started_at.getTime(),
      ).toBeGreaterThanOrEqual(30);
      expect(inserted.rows[0]!.expires_at.getTime() - inserted.rows[0]!.created_at.getTime()).toBe(
        10 * 60 * 1_000,
      );
    } catch (error) {
      await database.exec("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await database.close();
    }
  }, 60_000);

  test("rejects raw renewal after source state or catalogue epoch changes", async () => {
    const database = await prerequisiteDatabase();
    try {
      await applyMigrations(database);
      await database.exec(atomicRootAuthorityInsert());
      await database.exec(bindingInsert());
      await database.exec(leaseInsert());
      await database.exec(`UPDATE agent_sandbox_backups SET catalog_state = 'expiration_pending'
        WHERE id = '${BACKUP_ID}'`);
      await expect(
        database.exec(`UPDATE agent_backup_restore_leases
          SET expires_at = clock_timestamp() + INTERVAL '20 minutes' WHERE id = '${LEASE_ID}'`),
      ).rejects.toThrow(/renewal source authority is stale/);
      await database.exec(`UPDATE agent_sandbox_backups SET catalog_state = 'protected'
        WHERE id = '${BACKUP_ID}'`);
      await database.exec(`UPDATE agent_backup_catalog_authorities SET catalog_revision = 10
        WHERE organization_id = '${ORG_ID}' AND agent_id = '${AGENT_ID}'`);
      await expect(
        database.exec(`UPDATE agent_backup_restore_leases
          SET expires_at = clock_timestamp() + INTERVAL '20 minutes' WHERE id = '${LEASE_ID}'`),
      ).rejects.toThrow(/renewal catalogue epoch is stale/);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("enforces one vault chain, direct pointer steps, and exact backup scalars", async () => {
    const database = await prerequisiteDatabase();
    try {
      await applyMigrations(database);
      await expect(database.exec(generationInsert({ generationId: VAULT_ROOT }))).rejects.toThrow(
        /must exist and finish at the chain tip/,
      );
      await database.exec(atomicRootAuthorityInsert());
      await expect(
        database.exec(generationInsert({ generationId: "00000000-0000-4000-8000-00000000f030" })),
      ).rejects.toThrow(/root must begin an empty committed chain/);
      await expect(
        database.exec(
          generationInsert(
            { generationId: VAULT_CYCLE_A, supersedes: VAULT_CYCLE_B },
            { generationId: VAULT_CYCLE_B, supersedes: VAULT_CYCLE_A },
          ),
        ),
      ).rejects.toThrow(/extend the committed current generation/);
      await expect(
        database.exec(
          generationInsert(
            { generationId: VAULT_CYCLE_A, supersedes: VAULT_CYCLE_B },
            { generationId: VAULT_CYCLE_B, supersedes: VAULT_CYCLE_C },
            { generationId: VAULT_CYCLE_C, supersedes: VAULT_CYCLE_A },
          ),
        ),
      ).rejects.toThrow(/extend the committed current generation/);
      await expect(
        database.exec(generationInsert({ generationId: VAULT_SUCCESSOR, supersedes: VAULT_ROOT })),
      ).rejects.toThrow(/finish at the chain tip/);
      await expect(
        database.exec(
          generationInsert(
            { generationId: VAULT_SUCCESSOR, supersedes: VAULT_ROOT },
            {
              generationId: "00000000-0000-4000-8000-00000000f031",
              supersedes: VAULT_ROOT,
            },
          ),
        ),
      ).rejects.toThrow(/one_successor_uidx/);
      await expect(
        database.exec(`UPDATE agent_vault_key_authorities
          SET current_generation_id = '${VAULT_GRANDCHILD}', revision = 2
          WHERE organization_id = '${ORG_ID}' AND agent_id = '${AGENT_ID}'`),
      ).rejects.toThrow(/one direct successor/);
      await expect(
        database.transaction(async (tx) => {
          await tx.exec(
            generationInsert({ generationId: VAULT_SUCCESSOR, supersedes: VAULT_ROOT }),
          );
          await tx.exec(`UPDATE agent_vault_key_authorities
            SET current_generation_id = '${VAULT_SUCCESSOR}', revision = 3
            WHERE organization_id = '${ORG_ID}' AND agent_id = '${AGENT_ID}'`);
        }),
      ).rejects.toThrow(/one direct successor/);
      await database.transaction(async (tx) => {
        await tx.exec(generationInsert({ generationId: VAULT_SUCCESSOR, supersedes: VAULT_ROOT }));
        await tx.exec(`UPDATE agent_vault_key_authorities
          SET current_generation_id = '${VAULT_SUCCESSOR}', revision = 2
          WHERE organization_id = '${ORG_ID}' AND agent_id = '${AGENT_ID}'`);
      });
      await expect(
        database.exec(
          generationInsert({
            generationId: "00000000-0000-4000-8000-00000000f032",
            supersedes: VAULT_ROOT,
          }),
        ),
      ).rejects.toThrow(/extend the committed current generation/);
      await expect(
        database.exec(
          generationInsert({ generationId: VAULT_GRANDCHILD, supersedes: VAULT_SUCCESSOR }),
        ),
      ).rejects.toThrow(/finish at the chain tip/);
      await expect(
        database.exec(`UPDATE agent_vault_key_authorities
          SET current_generation_id = '${VAULT_ROOT}', revision = 3
          WHERE organization_id = '${ORG_ID}' AND agent_id = '${AGENT_ID}'`),
      ).rejects.toThrow(/one direct successor/);
      await database.transaction(async (tx) => {
        await tx.exec(
          generationInsert({ generationId: VAULT_GRANDCHILD, supersedes: VAULT_SUCCESSOR }),
        );
        await tx.exec(`UPDATE agent_vault_key_authorities
          SET current_generation_id = '${VAULT_GRANDCHILD}', revision = 3
          WHERE organization_id = '${ORG_ID}' AND agent_id = '${AGENT_ID}'`);
      });
      await expect(database.exec("DELETE FROM agent_vault_key_authorities")).rejects.toThrow(
        /cannot be deleted/,
      );

      await expect(database.exec(bindingInsert(VAULT_SUCCESSOR))).rejects.toThrow(
        /backup_authority_fkey/,
      );
      await database.exec(bindingInsert());
      await expect(
        database.exec(`UPDATE agent_sandbox_backups
          SET vault_key_generation_id = '${VAULT_SUCCESSOR}' WHERE id = '${BACKUP_ID}'`),
      ).rejects.toThrow(/vault_restore_authority_unique|backup_authority_fkey/);
      for (const statement of [
        `UPDATE agent_vault_key_generations SET kms_context = '{"changed":true}'
          WHERE generation_id = '${VAULT_ROOT}'`,
        `DELETE FROM agent_vault_key_generations WHERE generation_id = '${VAULT_ROOT}'`,
        `UPDATE agent_vault_key_backup_bindings SET manifest_sha256 = '${RECEIPT_SHA}'`,
        `DELETE FROM agent_vault_key_backup_bindings`,
      ]) {
        await expect(database.exec(statement)).rejects.toThrow(/immutable restore authority/);
      }
      for (const statement of [
        "TRUNCATE agent_vault_key_backup_bindings",
        "TRUNCATE agent_backup_restore_leases",
        "TRUNCATE agent_vault_key_generations CASCADE",
        "TRUNCATE agent_vault_key_authorities CASCADE",
        "TRUNCATE agent_backup_catalog_authorities CASCADE",
      ]) {
        await expect(database.exec(statement)).rejects.toThrow(
          /immutable restore authority cannot be TRUNCATE/,
        );
      }
    } finally {
      await database.close();
    }
  }, 60_000);
});
