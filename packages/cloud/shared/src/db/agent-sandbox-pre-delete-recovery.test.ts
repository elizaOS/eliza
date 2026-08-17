/**
 * Exercises pre-delete recovery retention against real PGlite tables: the
 * migration preserves only a deliberately detached backup across parent
 * deletion, while repository reads and cleanup enforce tenant and expiry
 * boundaries and remove offloaded bytes.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.ELIZA_KMS_BACKEND = "memory";

const MIGRATION_SQL = readFileSync(
  join(import.meta.dir, "migrations/0204_retain_pre_delete_backup.sql"),
  "utf8",
);
const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const ORG_B = "00000000-0000-4000-8000-0000000000b1";
const AGENT_ID = "00000000-0000-4000-8000-0000000000c1";
const BACKUP_ID = "00000000-0000-4000-8000-0000000000d1";
const ATTEMPT_ID = "00000000-0000-4000-8000-0000000000e1";
const USER_ID = "00000000-0000-4000-8000-0000000000f1";
const NOW = new Date("2026-08-13T12:00:00.000Z");

let dbWrite: typeof import("./helpers").dbWrite;
let closeDb: typeof import("./client").closeDatabaseConnectionsForTests;
let repository: typeof import("./repositories/agent-sandboxes").agentSandboxesRepository;
let setRuntimeR2Bucket: typeof import("../lib/storage/r2-runtime-binding").setRuntimeR2Bucket;

async function insertRecovery(params: {
  id: string;
  organizationId?: string;
  agentId?: string;
  expiresAt: Date;
  storage?: "inline" | "r2";
  key?: string | null;
}): Promise<void> {
  await dbWrite.execute(`
    INSERT INTO agent_sandbox_backups (
      id, sandbox_record_id, snapshot_type, state_data, state_data_storage,
      state_data_key, backup_kind, verification_status, verified_at,
      recovery_organization_id,
      recovery_agent_id, recovery_deletion_attempt_id, recovery_expires_at
    ) VALUES (
      '${params.id}', NULL, 'pre-delete',
      '{"memories":[],"config":{},"workspaceFiles":{}}'::jsonb,
      '${params.storage ?? "inline"}',
      ${params.key === undefined || params.key === null ? "NULL" : `'${params.key}'`},
      'full', 'verified', now(), '${params.organizationId ?? ORG_A}',
      '${params.agentId ?? AGENT_ID}', '${params.id}',
      '${params.expiresAt.toISOString()}'::timestamptz
    )
  `);
}

beforeAll(async () => {
  ({ dbWrite } = await import("./helpers"));
  ({ closeDatabaseConnectionsForTests: closeDb } = await import("./client"));
  ({ agentSandboxesRepository: repository } = await import("./repositories/agent-sandboxes"));
  ({ setRuntimeR2Bucket } = await import("../lib/storage/r2-runtime-binding"));
  // The repository selects every column of the live Drizzle schema, so the
  // suite pushes that schema instead of mirroring DDL by hand (the earlier
  // hand-written table drifted behind the backup-catalog migrations).
  const { organizations } = await import("./schemas/organizations");
  const { users } = await import("./schemas/users");
  const { userCharacters } = await import("./schemas/user-characters");
  const { agentSandboxes, agentSandboxBackups, agentBackupCatalogAuthorities } = await import(
    "./schemas/agent-sandboxes"
  );
  const { agentBackupObjects } = await import("./schemas/agent-backup-catalog");
  const { pushSchema } = await import("./push-schema-for-tests");
  const { apply } = await pushSchema(
    {
      organizations,
      users,
      userCharacters,
      agentSandboxes,
      agentSandboxBackups,
      agentBackupCatalogAuthorities,
      agentBackupObjects,
    } as never,
    dbWrite as never,
  );
  await apply();
  await dbWrite.execute(`
    INSERT INTO organizations (id, name, slug)
    VALUES ('${ORG_A}', 'Org A', 'org-a'), ('${ORG_B}', 'Org B', 'org-b')
  `);
  await dbWrite.execute(`
    INSERT INTO users (id, organization_id, role, steward_user_id)
    VALUES ('${USER_ID}', '${ORG_A}', 'owner', 'steward-${USER_ID}')
  `);
  await dbWrite.execute(`
    INSERT INTO agent_sandboxes (id, organization_id, user_id, agent_name)
    VALUES ('${AGENT_ID}', '${ORG_A}', '${USER_ID}', 'Recovery Agent')
  `);
}, 60_000);

beforeEach(async () => {
  await dbWrite.execute("DELETE FROM agent_sandbox_backups");
  setRuntimeR2Bucket(null);
});

afterEach(() => {
  setRuntimeR2Bucket(null);
});

afterAll(async () => {
  await closeDb();
});

describe("pre-delete recovery repository", () => {
  test("detaches only the exact pre-delete backup and records its deletion attempt", async () => {
    await dbWrite.execute(`
      INSERT INTO agent_sandbox_backups (
        id, sandbox_record_id, snapshot_type, state_data, backup_kind,
        verification_status, verified_at
      ) VALUES (
        '${BACKUP_ID}', '${AGENT_ID}', 'pre-delete',
        '{"memories":[],"config":{},"workspaceFiles":{}}'::jsonb, 'full',
        'verified', now()
      )
    `);

    await expect(
      dbWrite.transaction((tx) =>
        repository.validateAttachedPreDeleteBackupForDeletion(tx, {
          backupId: BACKUP_ID,
          sandboxRecordId: AGENT_ID,
          deletionStartedAt: new Date("2026-08-13T00:00:00.000Z"),
        }),
      ),
    ).resolves.toBe(true);

    const retained = await dbWrite.transaction((tx) =>
      repository.retainPreDeleteBackupForDeletedAgent(tx, {
        backupId: BACKUP_ID,
        sandboxRecordId: AGENT_ID,
        organizationId: ORG_A,
        deletionAttemptId: ATTEMPT_ID,
        deletionStartedAt: new Date("2026-08-13T00:00:00.000Z"),
        expiresAt: new Date("2026-09-12T12:00:00.000Z"),
      }),
    );

    expect(retained).toBe(true);
    const result = await dbWrite.execute(
      `SELECT * FROM agent_sandbox_backups WHERE id = '${BACKUP_ID}'`,
    );
    const row = (result as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
    expect(row?.sandbox_record_id).toBeNull();
    expect(row?.recovery_organization_id).toBe(ORG_A);
    expect(row?.recovery_agent_id).toBe(AGENT_ID);
    expect(row?.recovery_deletion_attempt_id).toBe(ATTEMPT_ID);

    await expect(
      dbWrite.transaction((tx) =>
        repository.validateAttachedPreDeleteBackupForDeletion(tx, {
          backupId: BACKUP_ID,
          sandboxRecordId: AGENT_ID,
          deletionStartedAt: new Date("2026-08-13T00:00:00.000Z"),
        }),
      ),
    ).resolves.toBe(false);

    await expect(
      dbWrite.transaction((tx) =>
        repository.retainPreDeleteBackupForDeletedAgent(tx, {
          backupId: BACKUP_ID,
          sandboxRecordId: AGENT_ID,
          organizationId: ORG_A,
          deletionAttemptId: ATTEMPT_ID,
          deletionStartedAt: new Date("2026-08-13T00:00:00.000Z"),
          expiresAt: new Date("2026-09-12T12:00:00.000Z"),
        }),
      ),
    ).resolves.toBe(false);
  });

  test("accepts only a capture created at or after the deletion intent", async () => {
    await dbWrite.execute(`
      INSERT INTO agent_sandbox_backups (
        id, sandbox_record_id, snapshot_type, state_data, backup_kind,
        verification_status, verified_at, created_at
      ) VALUES (
        '${BACKUP_ID}', '${AGENT_ID}', 'pre-delete',
        '{"memories":[],"config":{},"workspaceFiles":{}}'::jsonb, 'full',
        'verified', now(),
        '2026-08-13T11:59:59.999Z'::timestamptz
      )
    `);

    await expect(
      dbWrite.transaction((tx) =>
        repository.validateAttachedPreDeleteBackupForDeletion(tx, {
          backupId: BACKUP_ID,
          sandboxRecordId: AGENT_ID,
          deletionStartedAt: NOW,
        }),
      ),
    ).resolves.toBe(false);

    await dbWrite.execute(`
      UPDATE agent_sandbox_backups
      SET created_at = '2026-08-13T12:00:00.001Z'::timestamptz
      WHERE id = '${BACKUP_ID}'
    `);
    await expect(
      dbWrite.transaction((tx) =>
        repository.validateAttachedPreDeleteBackupForDeletion(tx, {
          backupId: BACKUP_ID,
          sandboxRecordId: AGENT_ID,
          deletionStartedAt: NOW,
        }),
      ),
    ).resolves.toBe(true);
  });

  test("recovery lookup is tenant-scoped and excludes expired rows", async () => {
    await insertRecovery({
      id: BACKUP_ID,
      expiresAt: new Date("2026-08-14T12:00:00.000Z"),
    });

    await expect(
      repository.getPreDeleteRecoveryBackup(ORG_B, AGENT_ID, NOW),
    ).resolves.toBeUndefined();
    await expect(
      repository.getPreDeleteRecoveryBackup(ORG_A, AGENT_ID, NOW),
    ).resolves.toMatchObject({
      id: BACKUP_ID,
      recovery_organization_id: ORG_A,
    });
    await expect(
      repository.getPreDeleteRecoveryBackup(ORG_A, AGENT_ID, new Date("2026-08-15T12:00:00.000Z")),
    ).resolves.toBeUndefined();
  });

  test("expiry cleanup removes inline rows and R2 bytes but preserves future rows", async () => {
    const r2BackupId = "00000000-0000-4000-8000-0000000000d2";
    const futureBackupId = "00000000-0000-4000-8000-0000000000d3";
    const key = "agent-sandbox-backups/org/backup/state_data.json";
    await insertRecovery({ id: BACKUP_ID, expiresAt: new Date(NOW.getTime() - 1_000) });
    await insertRecovery({
      id: r2BackupId,
      expiresAt: new Date(NOW.getTime() - 1_000),
      storage: "r2",
      key,
    });
    await insertRecovery({
      id: futureBackupId,
      expiresAt: new Date(NOW.getTime() + 60_000),
      agentId: "00000000-0000-4000-8000-0000000000c2",
    });
    const deleteObject = mock(async () => {});
    setRuntimeR2Bucket({
      get: mock(async () => null),
      put: mock(async () => undefined),
      delete: deleteObject,
    });

    await expect(repository.cleanupExpiredPreDeleteRecoveryBackups(NOW)).resolves.toEqual({
      deletedRows: 2,
      deletedObjects: 1,
      failedRows: 0,
      invalidRows: 0,
    });
    expect(deleteObject).toHaveBeenCalledWith(key);
    const remaining = await dbWrite.execute("SELECT id FROM agent_sandbox_backups ORDER BY id");
    expect((remaining as unknown as { rows: Array<{ id: string }> }).rows).toEqual([
      { id: futureBackupId },
    ]);
  });

  test("an R2 poison row is retained for retry without starving later rows", async () => {
    const key = "agent-sandbox-backups/org/backup/state_data.json";
    const healthyBackupId = "00000000-0000-4000-8000-0000000000d2";
    await insertRecovery({
      id: BACKUP_ID,
      expiresAt: new Date(NOW.getTime() - 2_000),
      storage: "r2",
      key,
    });
    await insertRecovery({
      id: healthyBackupId,
      expiresAt: new Date(NOW.getTime() - 1_000),
    });
    setRuntimeR2Bucket({
      get: mock(async () => null),
      put: mock(async () => undefined),
      delete: mock(async () => {
        throw new Error("R2 unavailable");
      }),
    });

    await expect(repository.cleanupExpiredPreDeleteRecoveryBackups(NOW)).resolves.toEqual({
      deletedRows: 1,
      deletedObjects: 0,
      failedRows: 1,
      invalidRows: 0,
    });
    const remaining = await dbWrite.execute("SELECT id FROM agent_sandbox_backups ORDER BY id");
    expect((remaining as unknown as { rows: Array<{ id: string }> }).rows).toEqual([
      { id: BACKUP_ID },
    ]);
  });

  test("discards an irrecoverable R2 row with no key and accounts for it", async () => {
    await insertRecovery({
      id: BACKUP_ID,
      expiresAt: new Date(NOW.getTime() - 1_000),
      storage: "r2",
      key: null,
    });

    await expect(repository.cleanupExpiredPreDeleteRecoveryBackups(NOW)).resolves.toEqual({
      deletedRows: 1,
      deletedObjects: 0,
      failedRows: 0,
      invalidRows: 1,
    });
    const remaining = await dbWrite.execute("SELECT id FROM agent_sandbox_backups");
    expect((remaining as unknown as { rows: Array<{ id: string }> }).rows).toEqual([]);
  });
});

describe("0204 retained pre-delete backup migration", () => {
  test("parent deletion keeps the detached recovery row and cascades ordinary backups", async () => {
    const client = new PGlite();
    try {
      await client.exec(`
        CREATE TABLE organizations (id uuid PRIMARY KEY);
        CREATE TABLE agent_sandboxes (
          id uuid PRIMARY KEY,
          organization_id uuid NOT NULL REFERENCES organizations(id),
          sandbox_id text,
          deletion_attempt_id uuid,
          environment_revision integer NOT NULL DEFAULT 0
        );
        CREATE TABLE agent_sandbox_backups (
          id uuid PRIMARY KEY,
          sandbox_record_id uuid NOT NULL REFERENCES agent_sandboxes(id) ON DELETE CASCADE,
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
          created_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO organizations (id) VALUES ('${ORG_A}');
        INSERT INTO agent_sandboxes (id, organization_id) VALUES ('${AGENT_ID}', '${ORG_A}');
        INSERT INTO agent_sandbox_backups (id, sandbox_record_id, snapshot_type, state_data)
        VALUES
          ('${BACKUP_ID}', '${AGENT_ID}', 'pre-delete', '{}'::jsonb),
          ('00000000-0000-4000-8000-0000000000d9', '${AGENT_ID}', 'manual', '{}'::jsonb);

        -- Reproduce the provisioning worker's ensure-before-migrate order.
        ALTER TABLE agent_sandboxes
          ADD COLUMN pre_delete_capture_waiver_attempt_id uuid,
          ADD COLUMN pre_delete_capture_waiver_environment_revision integer,
          ADD COLUMN pre_delete_capture_waiver_sandbox_id text,
          ADD COLUMN pre_delete_capture_waiver_bridge_url text,
          ADD CONSTRAINT agent_sandboxes_pre_delete_capture_waiver_shape_check
          CHECK ((
            pre_delete_capture_waiver_attempt_id IS NULL
            AND pre_delete_capture_waiver_environment_revision IS NULL
            AND pre_delete_capture_waiver_sandbox_id IS NULL
            AND pre_delete_capture_waiver_bridge_url IS NULL
          ) OR (
            pre_delete_capture_waiver_attempt_id IS NOT NULL
            AND pre_delete_capture_waiver_attempt_id = deletion_attempt_id
            AND pre_delete_capture_waiver_environment_revision = environment_revision
            AND pre_delete_capture_waiver_sandbox_id IS NOT DISTINCT FROM sandbox_id
            AND pre_delete_capture_waiver_bridge_url IS NOT NULL
          ));
        ALTER TABLE agent_sandbox_backups
          ALTER COLUMN sandbox_record_id DROP NOT NULL,
          ADD COLUMN recovery_organization_id uuid,
          ADD COLUMN recovery_agent_id uuid,
          ADD COLUMN recovery_deletion_attempt_id uuid,
          ADD COLUMN recovery_expires_at timestamptz,
          ADD CONSTRAINT agent_sandbox_backups_recovery_organization_id_fkey
          FOREIGN KEY (recovery_organization_id)
          REFERENCES organizations(id) ON DELETE CASCADE,
          ADD CONSTRAINT agent_sandbox_backups_recovery_shape_check
          CHECK ((
            sandbox_record_id IS NOT NULL
            AND recovery_organization_id IS NULL
            AND recovery_agent_id IS NULL
            AND recovery_deletion_attempt_id IS NULL
            AND recovery_expires_at IS NULL
          ) OR (
            sandbox_record_id IS NULL
            AND snapshot_type = 'pre-delete'
            AND backup_kind = 'full'
            AND parent_backup_id IS NULL
            AND recovery_organization_id IS NOT NULL
            AND recovery_agent_id IS NOT NULL
            AND recovery_deletion_attempt_id IS NOT NULL
            AND recovery_expires_at IS NOT NULL
          ));
      `);
      await client.exec(MIGRATION_SQL);
      // The application schema guard may have created the CHECK first, and
      // deploy retries can replay this migration body. Both must be harmless.
      await client.exec(MIGRATION_SQL);
      await client.exec(`
        BEGIN;
        UPDATE agent_sandbox_backups
        SET sandbox_record_id = NULL,
            recovery_organization_id = '${ORG_A}',
            recovery_agent_id = '${AGENT_ID}',
            recovery_deletion_attempt_id = '${ATTEMPT_ID}',
            recovery_expires_at = '2026-09-12T12:00:00.000Z'
        WHERE id = '${BACKUP_ID}' AND snapshot_type = 'pre-delete';
        DELETE FROM agent_sandboxes WHERE id = '${AGENT_ID}';
        COMMIT;
      `);

      const rows = await client.query<{
        id: string;
        sandbox_record_id: string | null;
        recovery_organization_id: string;
      }>("SELECT id, sandbox_record_id, recovery_organization_id FROM agent_sandbox_backups");
      expect(rows.rows).toEqual([
        {
          id: BACKUP_ID,
          sandbox_record_id: null,
          recovery_organization_id: ORG_A,
        },
      ]);
      await expect(
        client.exec(`
          INSERT INTO agent_sandbox_backups (
            id, sandbox_record_id, snapshot_type, state_data
          ) VALUES (
            '00000000-0000-4000-8000-0000000000f1', NULL,
            'manual', '{}'::jsonb
          )
        `),
      ).rejects.toThrow("agent_sandbox_backups_recovery_shape_check");
      await expect(
        client.exec(`
          INSERT INTO agent_sandbox_backups (
            id, sandbox_record_id, snapshot_type, state_data, backup_kind,
            recovery_organization_id, recovery_agent_id,
            recovery_deletion_attempt_id, recovery_expires_at
          ) VALUES (
            '00000000-0000-4000-8000-0000000000f2', NULL,
            'pre-delete', '{}'::jsonb, 'incremental', '${ORG_A}',
            '${AGENT_ID}', '${ATTEMPT_ID}', '2026-09-12T12:00:00.000Z'
          )
        `),
      ).rejects.toThrow("agent_sandbox_backups_recovery_shape_check");
    } finally {
      await client.close();
    }
  });
});
