/**
 * Applies the backup write-epoch migration to real PGlite and proves legacy
 * object sets fail closed until their exact keys can be reconstructed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const TIMEOUT = 60_000;
const SANDBOX_ID = "00000000-0000-4000-8000-000000000187";
const BACKUP_ID = "00000000-0000-4000-8000-000000001187";
const CLEANUP_BACKUP_ID = "00000000-0000-4000-8000-000000005187";
const LEGACY_BACKUP_ID = "00000000-0000-4000-8000-000000009187";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000002187";
const OBJECT_SET_ID = "00000000-0000-4000-8000-000000003187";
const OTHER_OBJECT_SET_ID = "00000000-0000-4000-8000-000000004187";
const CREATED_AT = "2026-07-26T12:00:00.000Z";
const migrationUrl = new URL("./migrations/0190_agent_backup_write_epochs.sql", import.meta.url);

let dbWrite!: typeof import("./client").dbWrite;
let closeDb: typeof import("./client").closeDatabaseConnectionsForTests | undefined;
let columnsBeforeMigration: unknown[] = [];

function objectKey(objectSetId: string, index: number, backupId: string = BACKUP_ID): string {
  return (
    `agent-sandbox-backups/${ORGANIZATION_ID}/2026-07-26/` +
    `${backupId}.${objectSetId}/chunk-${String(index).padStart(6, "0")}.bin`
  );
}

function legacyDescriptor(plannedObjectKeys: string[], backupId: string = BACKUP_ID): string {
  return JSON.stringify({
    format: "elizaos.agent-backup-chunks",
    descriptorVersion: 1,
    backupSchemaVersion: 2,
    commitState: "staging",
    organizationId: ORGANIZATION_ID,
    sandboxRecordId: SANDBOX_ID,
    backupId,
    createdAt: CREATED_AT,
    plannedObjectKeys,
    failure: null,
  });
}

function migrationStatements(): string[] {
  const migration = readFileSync(fileURLToPath(migrationUrl), "utf8");
  return migration
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function applyMigration(): Promise<void> {
  for (const statement of migrationStatements()) {
    await dbWrite.execute(statement);
  }
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("./client"));
  await dbWrite.execute(`
      CREATE TABLE "agent_sandboxes" (
        "id" uuid PRIMARY KEY,
        "organization_id" uuid NOT NULL
      );
    `);
  await dbWrite.execute(`
      CREATE TABLE "agent_sandbox_backups" (
        "id" uuid PRIMARY KEY,
        "sandbox_record_id" uuid NOT NULL,
        "state_data_storage" text NOT NULL
      );
    `);
  await dbWrite.execute(`
      INSERT INTO "agent_sandbox_backups" (
        "id",
        "sandbox_record_id",
        "state_data_storage"
      ) VALUES (
        '${LEGACY_BACKUP_ID}',
        '${SANDBOX_ID}',
        'inline'
      );
    `);
  columnsBeforeMigration = (
    await dbWrite.execute(`
      SELECT "column_name"
      FROM information_schema.columns
      WHERE "table_schema" = 'public'
        AND "table_name" = 'agent_sandbox_backups'
        AND "column_name" IN (
          'snapshot_schema_version',
          'state_data_descriptor',
          'storage_commit_state',
          'storage_commit_error',
          'storage_commit_updated_at'
        )
      ORDER BY "column_name";
    `)
  ).rows;
  await dbWrite.execute(migrationStatements()[0]);
  await dbWrite.execute(`
      CREATE TABLE "agent_sandbox_backup_cleanup_intents" (
        "backup_id" uuid PRIMARY KEY,
        "organization_id" uuid NOT NULL,
        "sandbox_record_id" uuid NOT NULL,
        "descriptor" jsonb NOT NULL,
        "storage_commit_state" text NOT NULL,
        "created_at" timestamptz NOT NULL,
        "updated_at" timestamptz NOT NULL
      );
    `);
  await dbWrite.execute(`
      CREATE FUNCTION "capture_agent_sandbox_backup_cleanup_intents"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN OLD;
      END;
      $$;
    `);
  await dbWrite.execute(`
      CREATE TRIGGER "agent_sandboxes_capture_backup_cleanup"
        BEFORE DELETE ON "agent_sandboxes"
        FOR EACH ROW
        EXECUTE FUNCTION "capture_agent_sandbox_backup_cleanup_intents"();
    `);
}, TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("0190 backup write epochs", () => {
  test("repairs backup-v2 columns absent from the historical migration chain", async () => {
    expect(columnsBeforeMigration).toEqual([]);
    const columns = await dbWrite.execute(`
      SELECT "column_name", "data_type", "is_nullable"
      FROM information_schema.columns
      WHERE "table_schema" = 'public'
        AND "table_name" = 'agent_sandbox_backups'
        AND "column_name" IN (
          'snapshot_schema_version',
          'state_data_descriptor',
          'storage_commit_state',
          'storage_commit_error',
          'storage_commit_updated_at'
        )
      ORDER BY "column_name";
    `);
    expect(columns.rows).toEqual([
      {
        column_name: "snapshot_schema_version",
        data_type: "integer",
        is_nullable: "NO",
      },
      {
        column_name: "state_data_descriptor",
        data_type: "jsonb",
        is_nullable: "YES",
      },
      {
        column_name: "storage_commit_error",
        data_type: "text",
        is_nullable: "YES",
      },
      {
        column_name: "storage_commit_state",
        data_type: "text",
        is_nullable: "NO",
      },
      {
        column_name: "storage_commit_updated_at",
        data_type: "timestamp with time zone",
        is_nullable: "NO",
      },
    ]);
    const legacyRow = await dbWrite.execute(`
      SELECT
        "snapshot_schema_version",
        "state_data_descriptor",
        "storage_commit_state",
        "storage_commit_error",
        "storage_commit_updated_at" IS NOT NULL AS "has_storage_commit_updated_at"
      FROM "agent_sandbox_backups"
      WHERE "id" = '${LEGACY_BACKUP_ID}';
    `);
    expect(legacyRow.rows).toEqual([
      {
        snapshot_schema_version: 1,
        state_data_descriptor: null,
        storage_commit_state: "complete",
        storage_commit_error: null,
        has_storage_commit_updated_at: true,
      },
    ]);
  });
  test("is registered once in the migration journal", () => {
    const journal = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)),
        "utf8",
      ),
    ) as { entries: Array<{ tag: string }> };
    expect(
      journal.entries.filter((entry) => entry.tag === "0190_agent_backup_write_epochs"),
    ).toHaveLength(1);
  });

  test("rejects mixed legacy object sets, then backfills and fences one exact epoch", async () => {
    await dbWrite.execute(`
      INSERT INTO "agent_sandboxes" ("id", "organization_id")
      VALUES ('${SANDBOX_ID}', '${ORGANIZATION_ID}')
    `);
    await dbWrite.execute(`
      INSERT INTO "agent_sandbox_backups" (
        "id",
        "sandbox_record_id",
        "snapshot_schema_version",
        "state_data_storage",
        "state_data_descriptor",
        "storage_commit_state",
        "storage_commit_updated_at"
      ) VALUES (
        '${BACKUP_ID}',
        '${SANDBOX_ID}',
        2,
        'chunked-v2',
        '${legacyDescriptor([objectKey(OBJECT_SET_ID, 0), objectKey(OTHER_OBJECT_SET_ID, 1)])}'::jsonb,
        'staging',
        '${CREATED_AT}'::timestamptz
      );
    `);
    await dbWrite.execute(`
      INSERT INTO "agent_sandbox_backup_cleanup_intents" (
        "backup_id",
        "organization_id",
        "sandbox_record_id",
        "descriptor",
        "storage_commit_state",
        "created_at",
        "updated_at"
      ) VALUES (
        '${CLEANUP_BACKUP_ID}',
        '${ORGANIZATION_ID}',
        '${SANDBOX_ID}',
        '${legacyDescriptor(
          [
            objectKey(OBJECT_SET_ID, 0, CLEANUP_BACKUP_ID),
            objectKey(OTHER_OBJECT_SET_ID, 1, CLEANUP_BACKUP_ID),
          ],
          CLEANUP_BACKUP_ID,
        )}'::jsonb,
        'staging',
        '${CREATED_AT}'::timestamptz,
        '${CREATED_AT}'::timestamptz
      );
    `);

    await expect(applyMigration()).rejects.toThrow(
      "object-set identity cannot be reconstructed safely",
    );
    await dbWrite.execute(`
      UPDATE "agent_sandbox_backups"
      SET "state_data_descriptor" = '${legacyDescriptor([objectKey(OBJECT_SET_ID, 0)])}'::jsonb
      WHERE "id" = '${BACKUP_ID}';
    `);
    await expect(applyMigration()).rejects.toThrow(
      "cleanup-intent object-set identity cannot be reconstructed safely",
    );
    await dbWrite.execute(`
      UPDATE "agent_sandbox_backup_cleanup_intents"
      SET "descriptor" = '${legacyDescriptor(
        [objectKey(OBJECT_SET_ID, 0, CLEANUP_BACKUP_ID)],
        CLEANUP_BACKUP_ID,
      )}'::jsonb
      WHERE "backup_id" = '${CLEANUP_BACKUP_ID}';
    `);
    await applyMigration();
    await applyMigration();

    const persisted = await dbWrite.execute(`
      SELECT
        "storage_commit_state",
        "storage_commit_error",
        "state_data_descriptor" ->> 'objectSetId' AS "object_set_id",
        "state_data_descriptor" ->> 'writeLeaseExpiresAt' AS "write_lease_expires_at",
        "state_data_descriptor" -> 'writeQuiescedAt' AS "write_quiesced_at"
      FROM "agent_sandbox_backups"
      WHERE "id" = '${BACKUP_ID}';
    `);
    expect(persisted.rows).toEqual([
      {
        storage_commit_state: "failed",
        storage_commit_error: "Pre-write-epoch backup requires repeated exact-key reconciliation",
        object_set_id: OBJECT_SET_ID,
        write_lease_expires_at: CREATED_AT,
        write_quiesced_at: null,
      },
    ]);
    const persistedIntent = await dbWrite.execute(`
      SELECT
        "storage_commit_state",
        "descriptor" ->> 'objectSetId' AS "object_set_id",
        "descriptor" ->> 'writeLeaseExpiresAt' AS "write_lease_expires_at",
        "descriptor" -> 'writeQuiescedAt' AS "write_quiesced_at",
        "descriptor" ->> 'failure' AS "failure"
      FROM "agent_sandbox_backup_cleanup_intents"
      WHERE "backup_id" = '${CLEANUP_BACKUP_ID}';
    `);
    expect(persistedIntent.rows).toEqual([
      {
        storage_commit_state: "failed",
        object_set_id: OBJECT_SET_ID,
        write_lease_expires_at: CREATED_AT,
        write_quiesced_at: null,
        failure: "Pre-write-epoch cleanup intent requires repeated exact-key reconciliation",
      },
    ]);

    const malformedBackupId = "00000000-0000-4000-8000-000000006187";
    const constraintFailure = await dbWrite
      .execute(`
        INSERT INTO "agent_sandbox_backups" (
          "id",
          "sandbox_record_id",
          "snapshot_schema_version",
          "state_data_storage",
          "state_data_descriptor",
          "storage_commit_state",
          "storage_commit_updated_at"
        ) VALUES (
          '${malformedBackupId}',
          '${SANDBOX_ID}',
          2,
          'chunked-v2',
          '${legacyDescriptor([]).replaceAll(BACKUP_ID, malformedBackupId)}'::jsonb,
          'staging',
          '${CREATED_AT}'::timestamptz
        )
      `)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(malformedBackupId).not.toBe(BACKUP_ID);
    expect((constraintFailure as Error & { cause?: unknown }).cause).toMatchObject({
      code: "23514",
    });

    const nullEpochBackupId = "00000000-0000-4000-8000-000000007187";
    const nullEpochFailure = await dbWrite
      .execute(`
        INSERT INTO "agent_sandbox_backups" (
          "id",
          "sandbox_record_id",
          "snapshot_schema_version",
          "state_data_storage",
          "state_data_descriptor",
          "storage_commit_state",
          "storage_commit_error",
          "storage_commit_updated_at"
        )
        SELECT
          '${nullEpochBackupId}',
          "sandbox_record_id",
          "snapshot_schema_version",
          "state_data_storage",
          jsonb_set(
            jsonb_set(
              "state_data_descriptor",
              '{backupId}',
              to_jsonb('${nullEpochBackupId}'::text)
            ),
            '{objectSetId}',
            'null'::jsonb
          ),
          "storage_commit_state",
          "storage_commit_error",
          "storage_commit_updated_at"
        FROM "agent_sandbox_backups"
        WHERE "id" = '${BACKUP_ID}'
      `)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect((nullEpochFailure as Error & { cause?: unknown }).cause).toMatchObject({
      code: "23514",
    });

    const nullEpochIntentId = "00000000-0000-4000-8000-000000008187";
    const nullEpochIntentFailure = await dbWrite
      .execute(`
        INSERT INTO "agent_sandbox_backup_cleanup_intents" (
          "backup_id",
          "organization_id",
          "sandbox_record_id",
          "descriptor",
          "storage_commit_state",
          "created_at",
          "updated_at"
        )
        SELECT
          '${nullEpochIntentId}',
          "organization_id",
          "sandbox_record_id",
          jsonb_set(
            jsonb_set(
              "descriptor",
              '{backupId}',
              to_jsonb('${nullEpochIntentId}'::text)
            ),
            '{writeLeaseExpiresAt}',
            'null'::jsonb
          ),
          "storage_commit_state",
          "created_at",
          "updated_at"
        FROM "agent_sandbox_backup_cleanup_intents"
        WHERE "backup_id" = '${CLEANUP_BACKUP_ID}'
      `)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect((nullEpochIntentFailure as Error & { cause?: unknown }).cause).toMatchObject({
      code: "23514",
    });

    const deletion = await dbWrite
      .execute(`DELETE FROM "agent_sandboxes" WHERE "id" = '${SANDBOX_ID}'`)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(deletion).toBeInstanceOf(Error);
    expect((deletion as Error & { cause?: unknown }).cause).toMatchObject({
      code: "55000",
      message: "Agent sandbox has an unquiesced backup write epoch",
    });
  });
});
