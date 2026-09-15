/** Proves backup admission indexes build online on real PostgreSQL 16. */

import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { acquireEphemeralPostgres } from "../../shared/src/lib/services/tenant-db/__tests__/ephemeral-postgres";
import type { Migration } from "./canonical-migration-ledger";
import { applyMigration, runMigrations } from "./migrate-with-diagnostics";

const enabled =
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: This opt-in is consumed by the standalone GitHub Actions/direct RealPG invocation, outside Turbo's cached task environment.
  process.env.REQUIRE_REAL_POSTGRES_BACKUP_ADMISSION_TESTS === "1" ||
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: The shared disposable-PostgreSQL helper exposes this direct-invocation opt-in outside Turbo's cached task environment.
  process.env.APPS_TENANT_DB_EPHEMERAL === "1" ||
  process.env.TEST_LANE === "post-merge";
const realPostgresTest = enabled ? test : test.skip;
const TEST_SCHEMA = "backup_admission_index_lock_budget_test";
const migrationTag = "0362_agent_backup_admission_claim_indexes";
const migrationWhen = 1_794_254_400_053;
const REPRESENTATIVE_INDEX = "agent_sandbox_backups_admission_active_org_idx";
const migrationIndexes = [
  "agent_backup_admission_claim_shards_turn_idx",
  "agent_backup_admission_work_claim_scan_idx",
  "agent_backup_admission_work_deferred_ready_shard_idx",
  "agent_backup_admission_work_expired_lease_shard_idx",
  "agent_sandbox_backups_admission_active_org_idx",
  "agent_sandbox_backups_admission_capture_fallback_idx",
  "agent_sandbox_backups_admission_capture_history_idx",
] as const;
const MIGRATION_OPTIONS = {
  timeoutMs: 15_000,
  maxAttempts: 1,
  baseDelayMs: 1,
  maxDelayMs: 1,
};
const SHORT_DEFAULT_LOCK_TIMEOUT_MS = 50;
const SHORT_DEFAULT_LOCK_TIMEOUT_OPTIONS = {
  ...MIGRATION_OPTIONS,
  timeoutMs: SHORT_DEFAULT_LOCK_TIMEOUT_MS,
};

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function concurrentMigration(
  tag: string,
  when: number,
  hash: string,
  statements: string[],
): Migration {
  return {
    entry: {
      breakpoints: true,
      idx: 362,
      tag,
      version: "7",
      when,
    },
    hash,
    statements: statements.map((statement, index) =>
      index === 0
        ? `-- migrate-with-diagnostics: nontransactional-concurrent-indexes\n${statement}`
        : statement,
    ),
  };
}

function migrationClient(
  client: Client,
  hooks: {
    afterQuery?: (text: string, params?: unknown[]) => Promise<void>;
    beforeQuery?: (text: string, params?: unknown[]) => Promise<void>;
  } = {},
) {
  return {
    backend: "postgres" as const,
    query: async <T = unknown>(text: string, params?: unknown[]) => {
      await hooks.beforeQuery?.(text, params);
      const result = await client.query(text, params);
      await hooks.afterQuery?.(text, params);
      return { rows: result.rows as T[] };
    },
    end: async () => {},
  };
}

async function indexPublication(
  client: Client,
  indexName: string,
): Promise<{
  marker: string | null;
  ready: boolean;
  valid: boolean;
}> {
  const result = await client.query<{
    marker: string | null;
    ready: boolean;
    valid: boolean;
  }>(
    `SELECT pg_catalog.obj_description(index_relation.oid, 'pg_class') AS marker,
      index_metadata.indisready AS ready,
      index_metadata.indisvalid AS valid
    FROM pg_catalog.pg_class AS index_relation
    JOIN pg_catalog.pg_index AS index_metadata
      ON index_metadata.indexrelid = index_relation.oid
    JOIN pg_catalog.pg_namespace AS relation_namespace
      ON relation_namespace.oid = index_relation.relnamespace
    WHERE relation_namespace.nspname = current_schema()
      AND index_relation.relname = $1`,
    [indexName],
  );
  const publication = result.rows[0];
  if (!publication || result.rows.length !== 1) {
    throw new Error(`Missing index publication state for ${indexName}`);
  }
  return publication;
}

async function relationFileNode(
  client: Client,
  relation: string,
): Promise<string> {
  const result = await client.query<{ file_node: string }>(
    "SELECT pg_relation_filenode($1::regclass)::text AS file_node",
    [relation],
  );
  const fileNode = result.rows[0]?.file_node;
  if (!fileNode) throw new Error(`Missing relation file node for ${relation}`);
  return fileNode;
}

async function backupAdmissionIndexes(
  client: Client,
): Promise<Array<{ name: string; ready: boolean; valid: boolean }>> {
  const result = await client.query<{
    name: string;
    ready: boolean;
    valid: boolean;
  }>(
    `SELECT index_relation.relname AS name,
      index_metadata.indisready AS ready, index_metadata.indisvalid AS valid
    FROM pg_index index_metadata
    JOIN pg_class table_relation ON table_relation.oid = index_metadata.indrelid
    JOIN pg_class index_relation ON index_relation.oid = index_metadata.indexrelid
    JOIN pg_namespace relation_namespace ON relation_namespace.oid = table_relation.relnamespace
    WHERE relation_namespace.nspname = current_schema()
      AND index_relation.relname = ANY($1::text[])
    ORDER BY index_relation.relname`,
    [migrationIndexes],
  );
  return result.rows;
}

async function waitForRepresentativeBuild(
  observer: Client,
  migratorPid: number,
  blockerPid: number,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{
      blocked_by_fixture: boolean;
      query: string;
      state: string;
    }>(
      `SELECT activity.query, activity.state,
        $2::int = ANY(pg_blocking_pids(activity.pid)) AS blocked_by_fixture
      FROM pg_stat_activity AS activity
      WHERE activity.pid = $1::int`,
      [migratorPid, blockerPid],
    );
    const activity = result.rows[0];
    if (
      activity?.state === "active" &&
      activity.blocked_by_fixture &&
      activity.query.includes(
        `CREATE INDEX CONCURRENTLY "${REPRESENTATIVE_INDEX}"`,
      )
    ) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(
    "Timed out waiting for the representative concurrent index build barrier",
  );
}

realPostgresTest(
  "outlives the session lock timeout while keeping a writer unblocked during the hot index build",
  async () => {
    const postgres = await acquireEphemeralPostgres();
    if (!postgres) {
      throw new Error("ephemeral PostgreSQL was requested but unavailable");
    }
    const databaseName = `backup_index_${randomUUID().replaceAll("-", "")}`;
    const databaseUrl = new URL(postgres.dsn);
    databaseUrl.pathname = `/${databaseName}`;
    const admin = new Client({ connectionString: postgres.dsn });
    const lockRunner = new Client({ connectionString: databaseUrl.toString() });
    const migrator = new Client({ connectionString: databaseUrl.toString() });
    const writer = new Client({ connectionString: databaseUrl.toString() });
    const blocker = new Client({ connectionString: databaseUrl.toString() });
    const observer = new Client({ connectionString: databaseUrl.toString() });

    let databaseCreated = false;
    let migrationRun: Promise<void> | undefined;
    let testFailure: unknown;
    try {
      await admin.connect();
      await admin.query(`CREATE DATABASE ${quotedIdentifier(databaseName)}`);
      databaseCreated = true;
      await Promise.all([
        lockRunner.connect(),
        migrator.connect(),
        writer.connect(),
        blocker.connect(),
        observer.connect(),
      ]);
      const version = await migrator.query<{ server_version_num: string }>(
        "SHOW server_version_num",
      );
      const versionNumber = Number(version.rows[0]?.server_version_num);
      expect(versionNumber).toBeGreaterThanOrEqual(160_000);
      expect(versionNumber).toBeLessThan(170_000);
      const [migratorPidResult, blockerPidResult] = await Promise.all([
        migrator.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid"),
        blocker.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid"),
      ]);
      const migratorPid = migratorPidResult.rows[0]?.pid;
      const blockerPid = blockerPidResult.rows[0]?.pid;
      if (!migratorPid || !blockerPid) {
        throw new Error(
          "backup admission index lock-budget backend PID is unavailable",
        );
      }

      await lockRunner.query(`SET lock_timeout = '37ms'`);
      let convergenceLockTimeout: string | undefined;
      await runMigrations(
        migrationClient(lockRunner),
        [
          {
            entry: {
              breakpoints: true,
              idx: 194,
              tag: "0194_job_execution_interruptions_catalog_guard",
              version: "7",
              when: migrationWhen - 20,
            },
            hash: "realpg-lock-timeout-checkpoint-hash",
            statements: ["SELECT 1"],
          },
        ],
        SHORT_DEFAULT_LOCK_TIMEOUT_OPTIONS,
        undefined,
        undefined,
        async (lockedClient) => {
          const setting = await lockedClient.query<{ lock_timeout: string }>(
            "SHOW lock_timeout",
          );
          convergenceLockTimeout = setting.rows[0]?.lock_timeout;
        },
      );
      expect(convergenceLockTimeout).toBe("37ms");
      const runnerSetting = await lockRunner.query<{ lock_timeout: string }>(
        "SHOW lock_timeout",
      );
      expect(runnerSetting.rows).toEqual([{ lock_timeout: "37ms" }]);
      await migrator.query("DROP SCHEMA drizzle CASCADE");

      await migrator.query(`
        DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE;
        CREATE SCHEMA ${TEST_SCHEMA};
        SET search_path TO ${TEST_SCHEMA}, public;
        CREATE SCHEMA drizzle;
        CREATE TABLE drizzle.__drizzle_migrations (
          id serial PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint NOT NULL
        );
      `);
      await Promise.all(
        [writer, blocker, observer].map((client) =>
          client.query(`SET search_path TO ${TEST_SCHEMA}, public`),
        ),
      );
      await migrator.query(`
        CREATE TABLE agent_backup_admission_claim_shards (
          work_kind text NOT NULL,
          last_turn bigint NOT NULL,
          shard_id integer NOT NULL
        );
        CREATE TABLE agent_backup_admission_work (
          id uuid PRIMARY KEY,
          work_kind text NOT NULL,
          shard_id integer NOT NULL,
          ready_cohort bigint NOT NULL,
          cohort_ordinal bigint NOT NULL,
          state text NOT NULL,
          not_before timestamptz,
          lease_expires_at timestamptz
        );
        CREATE TABLE agent_sandbox_backups (
          id uuid PRIMARY KEY,
          catalog_organization_id uuid NOT NULL,
          catalog_state text NOT NULL,
          catalog_resume_state text,
          source_node_history_id uuid,
          source_node_record_id uuid NOT NULL,
          source_node_incarnation uuid NOT NULL
        );
        INSERT INTO agent_sandbox_backups (
          id, catalog_organization_id, catalog_state, catalog_resume_state,
          source_node_history_id, source_node_record_id, source_node_incarnation
        )
        SELECT md5('backup-' || series)::uuid,
          '10000000-0000-4000-8000-000000000001'::uuid,
          CASE WHEN series % 8 = 0 THEN 'failed_retryable' ELSE 'scheduled' END,
          CASE WHEN series % 8 = 0 THEN 'capturing' ELSE NULL END,
          CASE WHEN series % 2 = 0 THEN md5('history-' || series)::uuid ELSE NULL END,
          md5('node-' || series)::uuid, md5('incarnation-' || series)::uuid
        FROM generate_series(1, 10000) AS series;
      `);

      const baseline = await migrator.query<{ backups: number }>(
        "SELECT count(*)::int AS backups FROM agent_sandbox_backups",
      );
      expect(baseline.rows).toEqual([{ backups: 10000 }]);
      const fileNode = await relationFileNode(
        migrator,
        "agent_sandbox_backups",
      );
      const source = await readFile(
        new URL(
          `../../shared/src/db/migrations/${migrationTag}.sql`,
          import.meta.url,
        ),
        "utf8",
      );
      const declaredIndexes = [
        ...source.matchAll(
          /^CREATE INDEX CONCURRENTLY IF NOT EXISTS "([a-z_][a-z0-9_]*)"/gm,
        ),
      ]
        .map((match) => match[1])
        .sort();
      expect(declaredIndexes).toEqual([...migrationIndexes]);

      await migrator.query(
        `CREATE TABLE ddl_race_table (id integer, other integer)`,
      );
      let collisionInjected = false;
      await expect(
        applyMigration(
          migrationClient(migrator, {
            beforeQuery: async (text) => {
              if (
                !collisionInjected &&
                text.includes(
                  'CREATE INDEX CONCURRENTLY "ddl_race_idx" ON "ddl_race_table"',
                )
              ) {
                collisionInjected = true;
                await writer.query(
                  `CREATE INDEX "ddl_race_idx" ON "ddl_race_table" ("other")`,
                );
              }
            },
          }),
          concurrentMigration(
            "0361_test_concurrent_index_ddl_race",
            migrationWhen - 10,
            "ddl-race-hash",
            [
              `CREATE INDEX CONCURRENTLY "ddl_race_idx" ON "ddl_race_table" ("id")`,
            ],
          ),
          MIGRATION_OPTIONS,
        ),
      ).rejects.toThrow(/already exists/i);
      const collision = await migrator.query<{
        definition: string;
        ledger_rows: number;
        marker: string | null;
      }>(`SELECT pg_get_indexdef('ddl_race_idx'::regclass) AS definition,
          obj_description('ddl_race_idx'::regclass, 'pg_class') AS marker,
          (SELECT count(*)::int FROM drizzle.__drizzle_migrations
            WHERE created_at = ${migrationWhen - 10}) AS ledger_rows`);
      expect(collision.rows[0]?.definition).toMatch(/\("?other"?\)$/);
      expect(collision.rows[0]).toMatchObject({ ledger_rows: 0, marker: null });

      await expect(
        applyMigration(
          migrationClient(migrator),
          concurrentMigration(
            "0361_test_concurrent_index_ddl_race",
            migrationWhen - 10,
            "ddl-race-hash",
            [
              `CREATE INDEX CONCURRENTLY "ddl_race_idx" ON "ddl_race_table" ("id")`,
            ],
          ),
          MIGRATION_OPTIONS,
        ),
      ).rejects.toThrow("PostgreSQL-canonical migration definition");
      expect(await indexPublication(migrator, "ddl_race_idx")).toEqual({
        marker: null,
        ready: true,
        valid: true,
      });
      await migrator.query(`DROP INDEX "ddl_race_idx"`);

      await migrator.query(`
        CREATE TABLE publication_swap_table (id integer, other integer);
        CREATE INDEX publication_swap_idx ON publication_swap_table (id);
        CREATE INDEX publication_swap_wrong_idx
          ON publication_swap_table (other);
      `);
      let publicationSwapInjected = false;
      await expect(
        applyMigration(
          migrationClient(migrator, {
            beforeQuery: async (text) => {
              if (
                !publicationSwapInjected &&
                text.includes(
                  'COMMENT ON INDEX "backup_admission_index_lock_budget_test"."publication_swap_idx"',
                )
              ) {
                publicationSwapInjected = true;
                await writer.query(`
                  ALTER INDEX publication_swap_idx
                    RENAME TO publication_swap_expected_saved_idx;
                  ALTER INDEX publication_swap_wrong_idx
                    RENAME TO publication_swap_idx;
                `);
              }
            },
          }),
          concurrentMigration(
            "0361_test_concurrent_index_publication_swap",
            migrationWhen - 11,
            "publication-swap-hash",
            [
              `CREATE INDEX CONCURRENTLY "publication_swap_idx" ON "publication_swap_table" ("id")`,
            ],
          ),
          MIGRATION_OPTIONS,
        ),
      ).rejects.toThrow("PostgreSQL-canonical migration definition");
      expect(publicationSwapInjected).toBe(true);
      const swapped = await migrator.query<{
        definition: string;
        ledger_rows: number;
        marker: string | null;
        saved_marker: string | null;
      }>(`SELECT pg_get_indexdef('publication_swap_idx'::regclass) AS definition,
          obj_description('publication_swap_idx'::regclass, 'pg_class') AS marker,
          obj_description(
            'publication_swap_expected_saved_idx'::regclass,
            'pg_class'
          ) AS saved_marker,
          (SELECT count(*)::int FROM drizzle.__drizzle_migrations
            WHERE created_at = ${migrationWhen - 11}) AS ledger_rows`);
      expect(swapped.rows[0]?.definition).toMatch(/\("?other"?\)$/);
      expect(swapped.rows[0]).toMatchObject({
        ledger_rows: 0,
        marker: null,
        saved_marker: null,
      });
      await migrator.query(`
        DROP INDEX publication_swap_idx;
        DROP INDEX publication_swap_expected_saved_idx;
      `);

      await migrator.query(`
        CREATE TABLE publication_attach_parent (id integer)
          PARTITION BY RANGE (id);
        CREATE TABLE publication_attach_child
          PARTITION OF publication_attach_parent
          FOR VALUES FROM (0) TO (100);
        CREATE INDEX publication_attach_parent_idx
          ON ONLY publication_attach_parent (id);
        CREATE INDEX publication_attach_child_idx
          ON publication_attach_child (id);
      `);
      let publicationAttachInjected = false;
      await expect(
        applyMigration(
          migrationClient(migrator, {
            beforeQuery: async (text) => {
              if (
                !publicationAttachInjected &&
                text.includes(
                  'COMMENT ON INDEX "backup_admission_index_lock_budget_test"."publication_attach_child_idx"',
                )
              ) {
                publicationAttachInjected = true;
                await writer.query(`
                  ALTER INDEX publication_attach_parent_idx
                    ATTACH PARTITION publication_attach_child_idx
                `);
              }
            },
          }),
          concurrentMigration(
            "0361_test_concurrent_index_publication_attach",
            migrationWhen - 12,
            "publication-attach-hash",
            [
              `CREATE INDEX CONCURRENTLY "publication_attach_child_idx" ON "publication_attach_child" ("id")`,
            ],
          ),
          MIGRATION_OPTIONS,
        ),
      ).rejects.toThrow("partition-attached");
      expect(publicationAttachInjected).toBe(true);
      const attached = await migrator.query<{
        attached: boolean;
        ledger_rows: number;
        marker: string | null;
      }>(`SELECT EXISTS (
            SELECT 1 FROM pg_catalog.pg_inherits
            WHERE inhparent = 'publication_attach_parent_idx'::regclass
              AND inhrelid = 'publication_attach_child_idx'::regclass
          ) AS attached,
          pg_catalog.obj_description(
            'publication_attach_child_idx'::regclass,
            'pg_class'
          ) AS marker,
          (SELECT count(*)::int FROM drizzle.__drizzle_migrations
            WHERE created_at = ${migrationWhen - 12}) AS ledger_rows`);
      expect(attached.rows).toEqual([
        { attached: true, ledger_rows: 0, marker: null },
      ]);

      await migrator.query(`CREATE TABLE crash_recovery_table (id integer)`);
      const crashMigration = concurrentMigration(
        "0361_test_concurrent_index_crash_recovery",
        migrationWhen - 9,
        "crash-recovery-hash",
        [
          `CREATE INDEX CONCURRENTLY "crash_recovery_idx" ON "crash_recovery_table" ("id")`,
        ],
      );
      let crashInjected = false;
      await expect(
        applyMigration(
          migrationClient(migrator, {
            afterQuery: async (text) => {
              if (
                !crashInjected &&
                text.includes('CREATE INDEX CONCURRENTLY "crash_recovery_idx"')
              ) {
                crashInjected = true;
                throw new Error(
                  "simulated process loss after CREATE INDEX and before publication",
                );
              }
            },
          }),
          crashMigration,
          MIGRATION_OPTIONS,
        ),
      ).rejects.toThrow("before publication");
      const crashFileNode = await relationFileNode(
        migrator,
        "crash_recovery_idx",
      );
      expect(await indexPublication(migrator, "crash_recovery_idx")).toEqual({
        marker: null,
        ready: true,
        valid: true,
      });
      const crashLedgerBefore = await migrator.query<{ rows: number }>(
        `SELECT count(*)::int AS rows FROM drizzle.__drizzle_migrations
        WHERE created_at = $1`,
        [migrationWhen - 9],
      );
      expect(crashLedgerBefore.rows).toEqual([{ rows: 0 }]);

      await applyMigration(
        migrationClient(migrator),
        crashMigration,
        MIGRATION_OPTIONS,
      );
      expect(await relationFileNode(migrator, "crash_recovery_idx")).toBe(
        crashFileNode,
      );
      expect(await indexPublication(migrator, "crash_recovery_idx")).toEqual({
        marker:
          "eliza:migration-index:v1:1794254400044:crash-recovery-hash:crash_recovery_idx",
        ready: true,
        valid: true,
      });

      await migrator.query(`
        CREATE TABLE invalid_remnant_table (id integer NOT NULL);
        INSERT INTO invalid_remnant_table (id) VALUES (1), (1);
      `);
      await expect(
        migrator.query(
          `CREATE UNIQUE INDEX CONCURRENTLY "invalid_remnant_idx"
          ON "invalid_remnant_table" ("id")`,
        ),
      ).rejects.toMatchObject({ code: "23505" });
      const invalidFileNode = await relationFileNode(
        migrator,
        "invalid_remnant_idx",
      );
      expect(
        (await indexPublication(migrator, "invalid_remnant_idx")).valid,
      ).toBe(false);
      await migrator.query(`
        DELETE FROM invalid_remnant_table
        WHERE ctid = (
          SELECT ctid FROM invalid_remnant_table ORDER BY ctid DESC LIMIT 1
        )
      `);
      const invalidMigration = concurrentMigration(
        "0361_test_concurrent_index_invalid_remnant",
        migrationWhen - 8,
        "invalid-remnant-hash",
        [
          `CREATE UNIQUE INDEX CONCURRENTLY "invalid_remnant_idx" ON "invalid_remnant_table" ("id")`,
        ],
      );
      const invalidRepairQueries: string[] = [];
      await expect(
        applyMigration(
          migrationClient(migrator, {
            beforeQuery: async (text) => {
              invalidRepairQueries.push(text);
            },
          }),
          invalidMigration,
          MIGRATION_OPTIONS,
        ),
      ).rejects.toThrow(
        "is incomplete; refusing automatic repair on a live table",
      );
      expect(await relationFileNode(migrator, "invalid_remnant_idx")).toBe(
        invalidFileNode,
      );
      expect(await indexPublication(migrator, "invalid_remnant_idx")).toEqual({
        marker: null,
        ready: false,
        valid: false,
      });
      const invalidLedgerBefore = await migrator.query<{ rows: number }>(
        `SELECT count(*)::int AS rows FROM drizzle.__drizzle_migrations
        WHERE created_at = $1`,
        [migrationWhen - 8],
      );
      expect(invalidLedgerBefore.rows).toEqual([{ rows: 0 }]);
      expect(
        invalidRepairQueries.some((text) =>
          /^(?:DROP|REINDEX)\s+INDEX\b/i.test(text),
        ),
      ).toBe(false);

      // Recovery is an explicit operator action, separate from the deploy
      // runner, and can use PostgreSQL's online drop after inspecting the
      // exact failed relation.
      await migrator.query(`DROP INDEX CONCURRENTLY "invalid_remnant_idx"`);
      await applyMigration(
        migrationClient(migrator),
        invalidMigration,
        MIGRATION_OPTIONS,
      );
      expect(await relationFileNode(migrator, "invalid_remnant_idx")).not.toBe(
        invalidFileNode,
      );
      expect(await indexPublication(migrator, "invalid_remnant_idx")).toEqual({
        marker:
          "eliza:migration-index:v1:1794254400045:invalid-remnant-hash:invalid_remnant_idx",
        ready: true,
        valid: true,
      });

      await migrator.query(`
        CREATE TABLE atomic_publication_table (id integer, other integer);
        CREATE FUNCTION fail_atomic_migration_ledger() RETURNS trigger
        LANGUAGE plpgsql AS $function$
        BEGIN
          IF NEW.created_at = ${migrationWhen - 7} THEN
            RAISE EXCEPTION 'simulated atomic ledger publication failure';
          END IF;
          RETURN NEW;
        END
        $function$;
        CREATE TRIGGER fail_atomic_migration_ledger
        BEFORE INSERT ON drizzle.__drizzle_migrations
        FOR EACH ROW EXECUTE FUNCTION fail_atomic_migration_ledger();
      `);
      const atomicMigration = concurrentMigration(
        "0361_test_concurrent_index_atomic_publication",
        migrationWhen - 7,
        "atomic-publication-hash",
        [
          `CREATE INDEX CONCURRENTLY "atomic_publication_id_idx" ON "atomic_publication_table" ("id")`,
          `CREATE INDEX CONCURRENTLY "atomic_publication_other_idx" ON "atomic_publication_table" ("other")`,
        ],
      );
      await expect(
        applyMigration(
          migrationClient(migrator),
          atomicMigration,
          MIGRATION_OPTIONS,
        ),
      ).rejects.toThrow("simulated atomic ledger publication failure");
      expect(
        await Promise.all(
          ["atomic_publication_id_idx", "atomic_publication_other_idx"].map(
            (indexName) => indexPublication(migrator, indexName),
          ),
        ),
      ).toEqual([
        { marker: null, ready: true, valid: true },
        { marker: null, ready: true, valid: true },
      ]);
      const atomicLedgerBefore = await migrator.query<{ rows: number }>(
        `SELECT count(*)::int AS rows FROM drizzle.__drizzle_migrations
        WHERE created_at = $1`,
        [migrationWhen - 7],
      );
      expect(atomicLedgerBefore.rows).toEqual([{ rows: 0 }]);
      await migrator.query(`
        DROP TRIGGER fail_atomic_migration_ledger
          ON drizzle.__drizzle_migrations;
        DROP FUNCTION fail_atomic_migration_ledger();
      `);
      await writer.query("SET statement_timeout = '2s'");
      let publicationDmlProved = false;
      await applyMigration(
        migrationClient(migrator, {
          beforeQuery: async (text) => {
            if (
              !publicationDmlProved &&
              text.includes('INSERT INTO "drizzle"."__drizzle_migrations"')
            ) {
              await writer.query(
                `INSERT INTO atomic_publication_table (id, other)
                VALUES (1, 2)`,
              );
              publicationDmlProved = true;
            }
          },
        }),
        atomicMigration,
        MIGRATION_OPTIONS,
      );
      expect(publicationDmlProved).toBe(true);
      expect(
        await Promise.all(
          ["atomic_publication_id_idx", "atomic_publication_other_idx"].map(
            (indexName) => indexPublication(migrator, indexName),
          ),
        ),
      ).toEqual([
        {
          marker:
            "eliza:migration-index:v1:1794254400046:atomic-publication-hash:atomic_publication_id_idx",
          ready: true,
          valid: true,
        },
        {
          marker:
            "eliza:migration-index:v1:1794254400046:atomic-publication-hash:atomic_publication_other_idx",
          ready: true,
          valid: true,
        },
      ]);

      await blocker.query("BEGIN");
      await blocker.query(`
        UPDATE agent_sandbox_backups
        SET catalog_state = catalog_state
        WHERE id = (SELECT id FROM agent_sandbox_backups ORDER BY id LIMIT 1)
      `);
      await migrator.query(
        `SET lock_timeout = '${SHORT_DEFAULT_LOCK_TIMEOUT_MS}ms'`,
      );

      let migrationSettled = false;
      migrationRun = applyMigration(
        {
          backend: "postgres",
          query: async <T = unknown>(text: string, params?: unknown[]) => {
            const result = await migrator.query(text, params);
            return { rows: result.rows as T[] };
          },
          end: async () => {},
        },
        {
          entry: {
            idx: 362,
            version: "7",
            when: migrationWhen,
            tag: migrationTag,
            breakpoints: true,
          },
          hash: createHash("sha256").update(source).digest("hex"),
          statements: source
            .split("--> statement-breakpoint")
            .map((statement) => statement.trim())
            .filter(Boolean),
        },
        SHORT_DEFAULT_LOCK_TIMEOUT_OPTIONS,
      ).finally(() => {
        migrationSettled = true;
      });
      // Keep the deliberately delayed rejection observed while the test proves
      // that the build remains pending past the configured timeout.
      void migrationRun.catch(() => {});

      await waitForRepresentativeBuild(observer, migratorPid, blockerPid);
      expect(migrationSettled).toBe(false);
      // The old session-scoped implementation aborted after 50 ms and left an
      // invalid remnant. Staying blocked for four full timeout windows proves
      // the concurrent DDL itself is running with lock_timeout disabled.
      await Bun.sleep(SHORT_DEFAULT_LOCK_TIMEOUT_MS * 4);
      expect(migrationSettled).toBe(false);
      await writer.query("SET statement_timeout = '2s'");
      const writerStartedAt = performance.now();
      await writer.query(`
        INSERT INTO agent_sandbox_backups (
          id, catalog_organization_id, catalog_state, source_node_history_id,
          source_node_record_id, source_node_incarnation
        ) VALUES (
          '50000000-0000-4000-8000-000000000001',
          '10000000-0000-4000-8000-000000000001', 'scheduled', NULL,
          '51000000-0000-4000-8000-000000000001',
          '52000000-0000-4000-8000-000000000001'
        )
      `);
      expect(performance.now() - writerStartedAt).toBeLessThan(1_500);
      expect(migrationSettled).toBe(false);

      await blocker.query("COMMIT");
      await migrationRun;

      expect(await relationFileNode(migrator, "agent_sandbox_backups")).toBe(
        fileNode,
      );
      expect(await backupAdmissionIndexes(migrator)).toEqual(
        migrationIndexes.map((name) => ({ name, ready: true, valid: true })),
      );
      const restoredLockTimeout = await migrator.query<{
        lock_timeout: string;
      }>("SHOW lock_timeout");
      expect(restoredLockTimeout.rows).toEqual([
        { lock_timeout: `${SHORT_DEFAULT_LOCK_TIMEOUT_MS}ms` },
      ]);
      const result = await migrator.query<{
        backups: number;
        concurrent_write: number;
        ledger_rows: number;
      }>(`
        SELECT count(*)::int AS backups,
          count(*) FILTER (
            WHERE id = '50000000-0000-4000-8000-000000000001'
          )::int AS concurrent_write,
          (SELECT count(*)::int FROM drizzle.__drizzle_migrations
            WHERE created_at = ${migrationWhen}) AS ledger_rows
        FROM agent_sandbox_backups
      `);
      expect(result.rows).toEqual([
        { backups: 10001, concurrent_write: 1, ledger_rows: 1 },
      ]);
    } catch (cause) {
      // error-policy:J2 Preserve the primary failure while completing teardown.
      testFailure = cause;
    }

    const cleanupErrors: unknown[] = [];
    for (const result of await Promise.allSettled([
      blocker.query("ROLLBACK"),
      writer.query("ROLLBACK"),
    ])) {
      if (result.status === "rejected") cleanupErrors.push(result.reason);
    }
    if (migrationRun) {
      try {
        await migrationRun;
      } catch (cause) {
        // error-policy:J6 Retain a migration failure while continuing teardown.
        cleanupErrors.push(cause);
      }
    }
    try {
      await migrator.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await migrator.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    } catch (cause) {
      // error-policy:J6 Continue teardown, but retain this failure for the aggregate.
      cleanupErrors.push(cause);
    }
    for (const result of await Promise.allSettled([
      lockRunner.end(),
      migrator.end(),
      writer.end(),
      blocker.end(),
      observer.end(),
    ])) {
      if (result.status === "rejected") cleanupErrors.push(result.reason);
    }
    if (databaseCreated) {
      try {
        await admin.query(`DROP DATABASE ${quotedIdentifier(databaseName)}`);
      } catch (cause) {
        // error-policy:J6 Continue teardown, but retain this failure for the aggregate.
        cleanupErrors.push(cause);
      }
    }
    try {
      await admin.end();
    } catch (cause) {
      // error-policy:J6 Continue teardown, but retain this failure for the aggregate.
      cleanupErrors.push(cause);
    }
    try {
      await postgres.stop();
    } catch (cause) {
      // error-policy:J6 Continue teardown, but retain this failure for the aggregate.
      cleanupErrors.push(cause);
    }
    if (testFailure !== undefined) cleanupErrors.unshift(testFailure);
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(
        cleanupErrors,
        "backup admission index lock-budget test or cleanup failed",
      );
    }
  },
  120_000,
);
