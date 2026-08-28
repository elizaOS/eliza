/** Proves the explicit concurrent-index migration mode is safe to replay. */

import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import type { Migration } from "./canonical-migration-ledger";
import {
  applyMigration,
  type MigrationClient,
  runMigrations,
} from "./migrate-with-diagnostics";

const DIRECTIVE =
  "-- migrate-with-diagnostics: nontransactional-concurrent-indexes";
const OPTIONS = {
  timeoutMs: 10,
  maxAttempts: 2,
  baseDelayMs: 1,
  maxDelayMs: 1,
};

interface IndexState {
  constraintOwned?: boolean;
  definition?: string;
  exclusion?: boolean;
  extensionOwned?: boolean;
  live: boolean;
  marker: string | null;
  oid?: string;
  partitionAttached?: boolean;
  primary?: boolean;
  ready: boolean;
  tableName: string;
  valid: boolean;
}

function concurrentMigration(statements: string[]): Migration {
  return {
    entry: {
      idx: 362,
      version: "7",
      when: 1_900_000_000_362,
      tag: "0362_test_concurrent_indexes",
      breakpoints: true,
    },
    hash: "concurrent-index-hash",
    statements: statements.map((statement, index) =>
      index === 0 ? `${DIRECTIVE}\n${statement}` : statement,
    ),
  };
}

function createIndex(name: string, table = "hot_table"): string {
  return `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${name}" ON "${table}" ("id")`;
}

function mockCanonicalDefinition(statement: string): string {
  const sql = statement
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trim();
  const match =
    /^CREATE\s+(UNIQUE\s+)?INDEX(?:\s+CONCURRENTLY)?(?:\s+IF\s+NOT\s+EXISTS)?\s+"[^"]+"\s+ON\s+"[^"]+"([\s\S]+)$/i.exec(
      sql,
    );
  if (!match?.[2])
    throw new Error(`invalid mock index statement: ${statement}`);
  return JSON.stringify({
    tail: match[2].replace(/\s+/g, " ").trim(),
    unique: match[1] !== undefined,
  });
}

function migrationClient(options?: {
  attachAfterCommentOnce?: string;
  collideBeforeCreateOnce?: string;
  failCommentOnce?: string;
  failCreateOnce?: string;
  failCreateWithLockTimeoutOnce?: string;
  failLedgerOnce?: boolean;
  failPublicationFenceLockTimeoutOnce?: boolean;
  indexes?: Map<string, IndexState>;
  lockTimeout?: string;
}): {
  client: MigrationClient;
  indexes: Map<string, IndexState>;
  ledgerRows(): number;
  lockTimeout(): string;
  queries: Array<{
    inTransaction: boolean;
    params?: unknown[];
    text: string;
  }>;
} {
  const indexes = options?.indexes ?? new Map<string, IndexState>();
  const definitions = new Map<string, string>();
  const queries: Array<{
    inTransaction: boolean;
    params?: unknown[];
    text: string;
  }> = [];
  let attachAfterCommentOnce = options?.attachAfterCommentOnce;
  let collideBeforeCreateOnce = options?.collideBeforeCreateOnce;
  let failCommentOnce = options?.failCommentOnce;
  let failCreateOnce = options?.failCreateOnce;
  let failCreateWithLockTimeoutOnce = options?.failCreateWithLockTimeoutOnce;
  let failLedgerOnce = options?.failLedgerOnce ?? false;
  let failPublicationFenceLockTimeoutOnce =
    options?.failPublicationFenceLockTimeoutOnce ?? false;
  let ledgerRows = 0;
  let lockTimeout = options?.lockTimeout ?? "0";
  let transactionSnapshot:
    | { indexes: Map<string, IndexState>; ledgerRows: number }
    | undefined;
  for (const [name, state] of indexes) state.oid ??= name;
  const cloneIndexes = (): Map<string, IndexState> =>
    new Map([...indexes].map(([name, state]) => [name, { ...state }] as const));
  const client: MigrationClient = {
    backend: "postgres",
    query: async <T = unknown>(text: string, params?: unknown[]) => {
      queries.push({
        inTransaction: transactionSnapshot !== undefined,
        text,
        params,
      });
      if (text === "BEGIN") {
        transactionSnapshot = { indexes: cloneIndexes(), ledgerRows };
        return { rows: [] as T[] };
      }
      if (text === "COMMIT") {
        transactionSnapshot = undefined;
        return { rows: [] as T[] };
      }
      if (text === "ROLLBACK") {
        if (transactionSnapshot) {
          indexes.clear();
          for (const [name, state] of transactionSnapshot.indexes) {
            indexes.set(name, { ...state });
          }
          ledgerRows = transactionSnapshot.ledgerRows;
        }
        transactionSnapshot = undefined;
        return { rows: [] as T[] };
      }
      if (
        text ===
        "SELECT pg_catalog.current_setting('lock_timeout') AS lock_timeout"
      ) {
        return { rows: [{ lock_timeout: lockTimeout }] as T[] };
      }
      if (
        text === "SELECT set_config('lock_timeout', $1, false)" &&
        typeof params?.[0] === "string"
      ) {
        lockTimeout = params[0];
        return { rows: [{ set_config: lockTimeout }] as T[] };
      }
      if (
        failPublicationFenceLockTimeoutOnce &&
        text.startsWith("LOCK TABLE") &&
        indexes.size > 0
      ) {
        failPublicationFenceLockTimeoutOnce = false;
        throw Object.assign(new Error("publication fence lock timeout"), {
          code: "55P03",
        });
      }
      if (text.includes("FROM (SELECT to_regclass($1) AS target_oid)")) {
        const tableName = String(params?.[0]);
        const name = String(params?.[1]);
        const state = indexes.get(name);
        return {
          rows: [
            state
              ? {
                  constraint_owned: state.constraintOwned ?? false,
                  exclusion: state.exclusion ?? false,
                  extension_owned: state.extensionOwned ?? false,
                  index_namespace: "public",
                  index_oid: state.oid ?? name,
                  indexed_table_oid: `table:${state.tableName}`,
                  relation_kind: "i",
                  table_name: state.tableName,
                  migration_marker: state.marker,
                  partition_attached: state.partitionAttached ?? false,
                  primary: state.primary ?? false,
                  ready: state.ready,
                  valid: state.valid,
                  live: state.live,
                  target_namespace: "public",
                  target_oid: `table:${tableName}`,
                  target_relation_kind: "r",
                }
              : {
                  constraint_owned: false,
                  exclusion: null,
                  extension_owned: false,
                  index_namespace: null,
                  index_oid: null,
                  indexed_table_oid: null,
                  relation_kind: null,
                  table_name: null,
                  migration_marker: null,
                  partition_attached: false,
                  primary: null,
                  ready: null,
                  valid: null,
                  live: null,
                  target_namespace: "public",
                  target_oid: `table:${tableName}`,
                  target_relation_kind: "r",
                },
          ] as T[],
        };
      }
      if (text.includes("WHERE index_metadata.indexrelid = $1::oid")) {
        const oid = String(params?.[0]);
        const stateEntry = [...indexes].find(
          ([name, candidate]) => (candidate.oid ?? name) === oid,
        );
        const state = stateEntry?.[1];
        const definition =
          state?.definition ??
          (state
            ? mockCanonicalDefinition(
                createIndex(stateEntry?.[0] ?? oid, state.tableName),
              )
            : definitions.get(oid));
        return {
          rows: definition
            ? ([{ canonical_definition: definition }] as T[])
            : ([] as T[]),
        };
      }
      if (text === "SELECT to_regclass($1)::oid::text AS index_oid") {
        const name = String(params?.[0]).replace(/^pg_temp\./, "");
        return {
          rows: [{ index_oid: definitions.has(name) ? name : null }] as T[],
        };
      }
      const probeCreateMatch =
        /CREATE\s+(?:UNIQUE\s+)?INDEX\s+"(__eliza_migration_index_shape_i_[0-9]+)"\s+ON\s+"__eliza_migration_index_shape_t_[0-9]+"/i.exec(
          text,
        );
      if (probeCreateMatch?.[1]) {
        definitions.set(probeCreateMatch[1], mockCanonicalDefinition(text));
      }
      const createMatch =
        /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+"([a-z_][a-z0-9_]*)"/i.exec(
          text,
        );
      if (createMatch?.[1]) {
        if (collideBeforeCreateOnce === createMatch[1]) {
          collideBeforeCreateOnce = undefined;
          indexes.set(createMatch[1], {
            definition: mockCanonicalDefinition(
              createIndex(createMatch[1], "hot_table").replace(
                '("id")',
                '("other")',
              ),
            ),
            live: true,
            marker: null,
            oid: createMatch[1],
            ready: true,
            tableName: "hot_table",
            valid: true,
          });
          throw Object.assign(new Error("relation already exists"), {
            code: "42P07",
          });
        }
        if (failCreateOnce === createMatch[1]) {
          failCreateOnce = undefined;
          throw new Error("simulated process loss during concurrent build");
        }
        if (failCreateWithLockTimeoutOnce === createMatch[1]) {
          failCreateWithLockTimeoutOnce = undefined;
          indexes.set(createMatch[1], {
            definition: mockCanonicalDefinition(text),
            live: true,
            marker: null,
            oid: createMatch[1],
            ready: false,
            tableName: /\s+ON\s+"([a-z_][a-z0-9_]*)"/i.exec(text)?.[1] ?? "",
            valid: false,
          });
          throw Object.assign(
            new Error("canceling statement due to lock timeout"),
            { code: "55P03" },
          );
        }
        indexes.set(createMatch[1], {
          definition: mockCanonicalDefinition(text),
          live: true,
          marker: null,
          oid: createMatch[1],
          ready: true,
          tableName: /\s+ON\s+"([a-z_][a-z0-9_]*)"/i.exec(text)?.[1] ?? "",
          valid: true,
        });
      }
      const commentMatch =
        /COMMENT\s+ON\s+INDEX\s+(?:"[a-z_][a-z0-9_]*"\.)?"([a-z_][a-z0-9_]*)"\s+IS\s+'([^']+)'/i.exec(
          text,
        );
      if (commentMatch?.[1] && commentMatch[2]) {
        if (failCommentOnce === commentMatch[1]) {
          failCommentOnce = undefined;
          throw new Error(
            "simulated process loss before index identity marker",
          );
        }
        const state = indexes.get(commentMatch[1]);
        if (state) {
          state.marker = commentMatch[2];
          if (attachAfterCommentOnce === commentMatch[1]) {
            attachAfterCommentOnce = undefined;
            state.partitionAttached = true;
            // Model a separate transaction winning the ATTACH race: rollback
            // removes our COMMENT but must preserve the external attachment.
            const snapshotted = transactionSnapshot?.indexes.get(
              commentMatch[1],
            );
            if (snapshotted) snapshotted.partitionAttached = true;
          }
        }
      }
      const dropMatch =
        /DROP\s+INDEX(?:\s+CONCURRENTLY)?\s+(?:"[a-z_][a-z0-9_]*"\.)?"([a-z_][a-z0-9_]*)"/i.exec(
          text,
        );
      if (dropMatch?.[1]) {
        indexes.delete(dropMatch[1]);
      }
      const renameMatch =
        /ALTER\s+INDEX\s+(?:"[a-z_][a-z0-9_]*"\.)?"([a-z_][a-z0-9_]*)"\s+RENAME\s+TO\s+"([a-z_][a-z0-9_]*)"/i.exec(
          text,
        );
      if (renameMatch?.[1] && renameMatch[2]) {
        const state = indexes.get(renameMatch[1]);
        if (!state) throw new Error("mock rename source is missing");
        indexes.delete(renameMatch[1]);
        indexes.set(renameMatch[2], state);
      }
      if (text.includes('INSERT INTO "drizzle"."__drizzle_migrations"')) {
        if (failLedgerOnce) {
          failLedgerOnce = false;
          throw new Error("simulated ledger publication failure");
        }
        ledgerRows += 1;
      }
      return { rows: [] as T[] };
    },
    end: async () => {},
  };
  return {
    client,
    indexes,
    ledgerRows: () => ledgerRows,
    lockTimeout: () => lockTimeout,
    queries,
  };
}

function migrationRunnerClient(options?: {
  advisoryFailure?: Error;
  initialLockTimeout?: string;
  rollbackFailure?: Error;
}) {
  const queries: Array<{ params?: unknown[]; text: string }> = [];
  const advisoryLockTimeouts: string[] = [];
  let ended = false;
  let lockHeld = false;
  let lockTimeout = options?.initialLockTimeout ?? "37ms";
  let transactionLockTimeout: string | undefined;

  const client: MigrationClient = {
    backend: "postgres",
    query: async <T = unknown>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }> => {
      queries.push({ text, params });
      if (text === "BEGIN") {
        transactionLockTimeout = lockTimeout;
        return { rows: [] };
      }
      if (text === "COMMIT") {
        lockTimeout = transactionLockTimeout ?? lockTimeout;
        transactionLockTimeout = undefined;
        return { rows: [] };
      }
      if (text === "ROLLBACK") {
        if (options?.rollbackFailure) throw options.rollbackFailure;
        lockTimeout = transactionLockTimeout ?? lockTimeout;
        transactionLockTimeout = undefined;
        return { rows: [] };
      }
      if (
        text === "SELECT set_config('lock_timeout', $1, true)" &&
        typeof params?.[0] === "string"
      ) {
        lockTimeout = params[0];
        return { rows: [{ set_config: lockTimeout }] as T[] };
      }
      // Model the former implementation so this regression test fails if the
      // production path again installs a session-scoped budget or resets to 0.
      if (
        text === "SELECT set_config('lock_timeout', $1, false)" &&
        typeof params?.[0] === "string"
      ) {
        lockTimeout = params[0];
        return { rows: [{ set_config: lockTimeout }] as T[] };
      }
      if (text === "SELECT set_config('lock_timeout', '0', false)") {
        lockTimeout = "0";
        return { rows: [{ set_config: lockTimeout }] as T[] };
      }
      if (text.includes("pg_advisory_lock")) {
        advisoryLockTimeouts.push(lockTimeout);
        if (options?.advisoryFailure) throw options.advisoryFailure;
        lockHeld = true;
        return { rows: [] };
      }
      if (text.includes("pg_advisory_unlock")) {
        const unlocked = lockHeld;
        lockHeld = false;
        return { rows: [{ unlocked }] as T[] };
      }
      if (text.includes(`FROM "drizzle"."__drizzle_migrations"`)) {
        return { rows: [] };
      }
      if (text.includes("AS has_user_relations")) {
        return { rows: [{ has_user_relations: false }] as T[] };
      }
      return { rows: [] };
    },
    end: async () => {
      ended = true;
    },
  };

  return {
    advisoryLockTimeouts,
    client,
    ended: () => ended,
    lockHeld: () => lockHeld,
    lockTimeout: () => lockTimeout,
    queries,
  };
}

describe("nontransactional concurrent-index migrations", () => {
  test("runMigrations restores the exact lock timeout after advisory-lock acquisition", async () => {
    const harness = migrationRunnerClient({ initialLockTimeout: "37ms" });
    let convergenceLockTimeout: string | undefined;
    const checkpointMigration: Migration = {
      entry: {
        breakpoints: true,
        idx: 194,
        tag: "0194_job_execution_interruptions_catalog_guard",
        version: "7",
        when: 1_900_000_000_194,
      },
      hash: "checkpoint-hash",
      statements: ["SELECT 1"],
    };

    await runMigrations(
      harness.client,
      [checkpointMigration],
      OPTIONS,
      undefined,
      undefined,
      async () => {
        convergenceLockTimeout = harness.lockTimeout();
      },
    );

    expect(harness.advisoryLockTimeouts).toEqual([`${OPTIONS.timeoutMs}ms`]);
    expect(convergenceLockTimeout).toBe("37ms");
    expect(harness.lockTimeout()).toBe("37ms");
    expect(harness.lockHeld()).toBe(false);
    expect(harness.ended()).toBe(true);
    const firstLocalBudget = harness.queries.findIndex(
      ({ text }) => text === "SELECT set_config('lock_timeout', $1, true)",
    );
    const advisoryAcquisition = harness.queries.findIndex(({ text }) =>
      text.includes("pg_advisory_lock"),
    );
    expect(firstLocalBudget).toBeGreaterThan(-1);
    expect(firstLocalBudget).toBeLessThan(advisoryAcquisition);
  });

  test("advisory-lock rollback cleanup cannot replace the acquisition error", async () => {
    const primary = Object.assign(new Error("advisory lock timeout"), {
      code: "55P03",
    });
    const harness = migrationRunnerClient({
      advisoryFailure: primary,
      initialLockTimeout: "37ms",
      rollbackFailure: new Error("rollback connection loss"),
    });

    await expect(runMigrations(harness.client, [], OPTIONS)).rejects.toBe(
      primary,
    );
    expect(harness.advisoryLockTimeouts).toEqual([`${OPTIONS.timeoutMs}ms`]);
    expect(harness.ended()).toBe(true);
  });

  test("runs outside PGlite's transaction wrapper and records the verified index", async () => {
    const database = new PGlite();
    try {
      await database.exec(`
        CREATE SCHEMA drizzle;
        CREATE TABLE drizzle.__drizzle_migrations (
          id serial PRIMARY KEY, hash text NOT NULL, created_at bigint
        );
        CREATE TABLE hot_table (id integer NOT NULL);
      `);
      const client: MigrationClient = {
        backend: "pglite",
        query: async <T = unknown>(text: string, params?: unknown[]) => {
          if (params && params.length > 0) {
            const result = await database.query<T>(text, params);
            return { rows: result.rows };
          }
          const results = await database.exec(text);
          return {
            rows: (results.at(-1)?.rows as T[] | undefined) ?? [],
          };
        },
        end: async () => {},
      };

      await applyMigration(
        client,
        concurrentMigration([createIndex("pglite_idx")]),
        OPTIONS,
      );

      const result = await database.query<{
        ledger_rows: number;
        marker: string | null;
        valid: boolean;
      }>(`
        SELECT index_metadata.indisvalid AS valid,
          obj_description(index_relation.oid, 'pg_class') AS marker,
          (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS ledger_rows
        FROM pg_index AS index_metadata
        JOIN pg_class AS index_relation
          ON index_relation.oid = index_metadata.indexrelid
        WHERE index_relation.relname = 'pglite_idx'
      `);
      expect(result.rows).toEqual([
        {
          ledger_rows: 1,
          marker:
            "eliza:migration-index:v1:1900000000362:concurrent-index-hash:pglite_idx",
          valid: true,
        },
      ]);
    } finally {
      await database.close();
    }
  });

  test("builds outside a transaction and commits the ledger only after validation", async () => {
    const harness = migrationClient();
    const first = createIndex("hot_first_idx");
    const second = createIndex("hot_second_idx");

    await applyMigration(
      harness.client,
      concurrentMigration([first, second]),
      OPTIONS,
    );

    const builds = harness.queries.filter(({ text }) =>
      /CREATE\s+INDEX\s+CONCURRENTLY/.test(text),
    );
    expect(builds.map(({ text }) => mockCanonicalDefinition(text))).toEqual([
      mockCanonicalDefinition(first),
      mockCanonicalDefinition(second),
    ]);
    expect(builds.every(({ inTransaction }) => !inTransaction)).toBe(true);
    expect(builds.every(({ text }) => !text.includes("IF NOT EXISTS"))).toBe(
      true,
    );
    const comments = harness.queries.filter(({ text }) =>
      text.startsWith("COMMENT ON INDEX"),
    );
    expect(comments).toHaveLength(2);
    expect(comments.every(({ inTransaction }) => inTransaction)).toBe(true);
    const ledger = harness.queries.find(({ text }) =>
      text.includes('INSERT INTO "drizzle"."__drizzle_migrations"'),
    );
    expect(ledger?.inTransaction).toBe(true);
    expect(harness.ledgerRows()).toBe(1);
    expect(
      harness.queries.filter(({ text }) =>
        text.includes("IN SHARE UPDATE EXCLUSIVE MODE"),
      ).length,
    ).toBeGreaterThanOrEqual(3);
    const tablespaceAlignments = harness.queries.filter(({ text }) =>
      text.includes(
        "set_config('temp_tablespaces', pg_catalog.current_setting('default_tablespace'), true)",
      ),
    );
    const tempProbeCount = harness.queries.filter(({ text }) =>
      text.startsWith("CREATE TEMP TABLE"),
    ).length;
    expect(tablespaceAlignments).toHaveLength(tempProbeCount);
    expect(
      tablespaceAlignments.every(({ inTransaction }) => inTransaction),
    ).toBe(true);
    expect(harness.indexes.size).toBe(2);
  });

  test("replays completed indexes after a crash without advancing the ledger early", async () => {
    const first = createIndex("crash_first_idx");
    const second = createIndex("crash_second_idx");
    const harness = migrationClient({ failCreateOnce: "crash_second_idx" });
    const migration = concurrentMigration([first, second]);

    await expect(
      applyMigration(harness.client, migration, OPTIONS),
    ).rejects.toThrow("simulated process loss");
    expect(
      harness.queries.some(({ text }) =>
        text.includes('INSERT INTO "drizzle"."__drizzle_migrations"'),
      ),
    ).toBe(false);
    expect(harness.indexes.get("crash_first_idx")?.valid).toBe(true);
    expect(harness.indexes.get("crash_first_idx")?.marker).toBeNull();
    expect(harness.ledgerRows()).toBe(0);

    await applyMigration(harness.client, migration, OPTIONS);
    expect(
      harness.queries.filter(({ text }) =>
        text.includes('CREATE INDEX CONCURRENTLY "crash_first_idx"'),
      ),
    ).toHaveLength(1);
    expect(
      harness.queries.filter(({ text }) =>
        text.includes('CREATE INDEX CONCURRENTLY "crash_second_idx"'),
      ),
    ).toHaveLength(2);
    expect(
      harness.queries.filter(({ text }) =>
        text.includes('INSERT INTO "drizzle"."__drizzle_migrations"'),
      ),
    ).toHaveLength(1);
    expect(harness.ledgerRows()).toBe(1);
    expect(harness.indexes.get("crash_first_idx")?.marker).toContain(
      "eliza:migration-index:v1:",
    );
  });

  test("does not retry a lock timeout after concurrent DDL submission", async () => {
    const harness = migrationClient({
      failCreateWithLockTimeoutOnce: "timed_out_idx",
      lockTimeout: "25ms",
    });
    const migration = concurrentMigration([createIndex("timed_out_idx")]);

    await expect(
      applyMigration(harness.client, migration, OPTIONS),
    ).rejects.toMatchObject({ code: "55P03" });
    expect(
      harness.queries.filter(({ text }) =>
        text.includes('CREATE INDEX CONCURRENTLY "timed_out_idx"'),
      ),
    ).toHaveLength(1);
    expect(harness.indexes.get("timed_out_idx")).toMatchObject({
      live: true,
      marker: null,
      ready: false,
      valid: false,
    });
    expect(harness.ledgerRows()).toBe(0);
    expect(harness.lockTimeout()).toBe("25ms");

    await expect(
      applyMigration(harness.client, migration, OPTIONS),
    ).rejects.toThrow(
      "is incomplete; refusing automatic repair on a live table",
    );
    expect(
      harness.queries.filter(({ text }) =>
        text.includes('CREATE INDEX CONCURRENTLY "timed_out_idx"'),
      ),
    ).toHaveLength(1);
    expect(harness.ledgerRows()).toBe(0);
  });

  test("retries a later publication-fence timeout by reusing the complete index", async () => {
    const harness = migrationClient({
      failPublicationFenceLockTimeoutOnce: true,
    });

    await applyMigration(
      harness.client,
      concurrentMigration([createIndex("publication_retry_idx")]),
      OPTIONS,
    );

    expect(
      harness.queries.filter(({ text }) =>
        text.includes('CREATE INDEX CONCURRENTLY "publication_retry_idx"'),
      ),
    ).toHaveLength(1);
    expect(harness.indexes.get("publication_retry_idx")).toMatchObject({
      live: true,
      marker:
        "eliza:migration-index:v1:1900000000362:concurrent-index-hash:publication_retry_idx",
      ready: true,
      valid: true,
    });
    expect(harness.ledgerRows()).toBe(1);
  });

  test("fails closed repeatedly on an exact incomplete remnant without DDL", async () => {
    const indexes = new Map<string, IndexState>([
      [
        "invalid_idx",
        {
          live: true,
          marker:
            "eliza:migration-index:v1:1900000000362:concurrent-index-hash:invalid_idx",
          oid: "invalid-original-oid",
          ready: false,
          tableName: "hot_table",
          valid: false,
        },
      ],
    ]);
    const harness = migrationClient({ indexes });

    const migration = concurrentMigration([createIndex("invalid_idx")]);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        applyMigration(harness.client, migration, OPTIONS),
      ).rejects.toThrow(
        "is incomplete; refusing automatic repair on a live table",
      );
      expect(harness.indexes.get("invalid_idx")).toMatchObject({
        live: true,
        marker:
          "eliza:migration-index:v1:1900000000362:concurrent-index-hash:invalid_idx",
        oid: "invalid-original-oid",
        ready: false,
        tableName: "hot_table",
        valid: false,
      });
      expect(harness.ledgerRows()).toBe(0);
      expect(
        harness.queries.some(
          ({ text }) =>
            /^(?:ALTER|COMMENT|DROP|REINDEX)\s+INDEX\b/i.test(text) ||
            text.includes('CREATE INDEX CONCURRENTLY "invalid_idx"'),
        ),
      ).toBe(false);
    }
  });

  test("resumes a complete unmarked index after a crash before publication", async () => {
    const harness = migrationClient({ failCommentOnce: "unmarked_idx" });
    const migration = concurrentMigration([createIndex("unmarked_idx")]);

    await expect(
      applyMigration(harness.client, migration, OPTIONS),
    ).rejects.toThrow("before index identity marker");
    expect(harness.indexes.get("unmarked_idx")?.marker).toBeNull();
    expect(
      harness.queries.some(({ text }) =>
        text.includes('INSERT INTO "drizzle"."__drizzle_migrations"'),
      ),
    ).toBe(false);

    await applyMigration(harness.client, migration, OPTIONS);
    expect(
      harness.queries.filter(({ text }) =>
        text.includes('CREATE INDEX CONCURRENTLY "unmarked_idx"'),
      ),
    ).toHaveLength(1);
    expect(
      harness.queries.filter(({ text }) =>
        text.includes('DROP INDEX "public"."unmarked_idx"'),
      ),
    ).toHaveLength(0);
    expect(harness.indexes.get("unmarked_idx")?.marker).toBe(
      "eliza:migration-index:v1:1900000000362:concurrent-index-hash:unmarked_idx",
    );
    expect(harness.ledgerRows()).toBe(1);
  });

  test("fails a same-name DDL race without stamping or ledgering the foreign index", async () => {
    const harness = migrationClient({ collideBeforeCreateOnce: "race_idx" });

    await expect(
      applyMigration(
        harness.client,
        concurrentMigration([createIndex("race_idx")]),
        OPTIONS,
      ),
    ).rejects.toThrow("relation already exists");
    expect(harness.indexes.get("race_idx")?.marker).toBeNull();
    expect(
      harness.queries.some(({ text }) =>
        text.includes('COMMENT ON INDEX "race_idx"'),
      ),
    ).toBe(false);
    expect(
      harness.queries.some(({ text }) =>
        text.includes('INSERT INTO "drizzle"."__drizzle_migrations"'),
      ),
    ).toBe(false);
  });

  test("refuses an index attached between validation and publication without stamping or ledgering it", async () => {
    const harness = migrationClient({
      attachAfterCommentOnce: "attached_during_publication_idx",
    });

    await expect(
      applyMigration(
        harness.client,
        concurrentMigration([createIndex("attached_during_publication_idx")]),
        OPTIONS,
      ),
    ).rejects.toThrow("partition-attached");
    expect(
      harness.indexes.get("attached_during_publication_idx"),
    ).toMatchObject({
      marker: null,
      partitionAttached: true,
    });
    expect(harness.ledgerRows()).toBe(0);
  });

  test("fails closed on an unmarked incomplete remnant after exact definition comparison", async () => {
    const indexes = new Map<string, IndexState>([
      [
        "foreign_invalid_idx",
        {
          live: true,
          marker: null,
          ready: false,
          tableName: "hot_table",
          valid: false,
        },
      ],
    ]);
    const harness = migrationClient({ indexes });

    await expect(
      applyMigration(
        harness.client,
        concurrentMigration([createIndex("foreign_invalid_idx")]),
        OPTIONS,
      ),
    ).rejects.toThrow(
      "is incomplete; refusing automatic repair on a live table",
    );
    expect(harness.indexes.get("foreign_invalid_idx")).toMatchObject({
      marker: null,
      ready: false,
      valid: false,
    });
    expect(
      harness.queries.some(({ text }) =>
        /^(?:DROP|REINDEX)\s+INDEX\b/i.test(text),
      ),
    ).toBe(false);
    expect(harness.ledgerRows()).toBe(0);
  });

  test("fails closed on a same-table index with a wrong canonical definition", async () => {
    const indexes = new Map<string, IndexState>([
      [
        "wrong_definition_idx",
        {
          definition: mockCanonicalDefinition(
            'CREATE INDEX "wrong_definition_idx" ON "hot_table" ("other")',
          ),
          live: true,
          marker: null,
          ready: true,
          tableName: "hot_table",
          valid: true,
        },
      ],
    ]);
    const harness = migrationClient({ indexes });

    await expect(
      applyMigration(
        harness.client,
        concurrentMigration([createIndex("wrong_definition_idx")]),
        OPTIONS,
      ),
    ).rejects.toThrow("PostgreSQL-canonical migration definition");
    expect(
      harness.queries.some(({ text }) =>
        /^(?:DROP INDEX|REINDEX INDEX CONCURRENTLY|COMMENT ON INDEX)/.test(
          text,
        ),
      ),
    ).toBe(false);
    expect(harness.ledgerRows()).toBe(0);
  });

  test("fails closed when an existing index belongs to another table", async () => {
    const indexes = new Map<string, IndexState>([
      [
        "collision_idx",
        {
          live: true,
          marker: null,
          ready: true,
          tableName: "unrelated_table",
          valid: true,
        },
      ],
    ]);
    const harness = migrationClient({ indexes });

    await expect(
      applyMigration(
        harness.client,
        concurrentMigration([createIndex("collision_idx")]),
        OPTIONS,
      ),
    ).rejects.toThrow("exact target namespace and table hot_table");
    expect(
      harness.queries.some(({ text }) =>
        /^(?:DROP INDEX|REINDEX INDEX CONCURRENTLY|COMMENT ON INDEX)/.test(
          text,
        ),
      ),
    ).toBe(false);
  });

  test("fails closed when an index carries another migration identity", async () => {
    const indexes = new Map<string, IndexState>([
      [
        "identity_idx",
        {
          live: true,
          marker: "eliza:migration-index:v1:different-definition",
          ready: true,
          tableName: "hot_table",
          valid: true,
        },
      ],
    ]);
    const harness = migrationClient({ indexes });

    await expect(
      applyMigration(
        harness.client,
        concurrentMigration([createIndex("identity_idx")]),
        OPTIONS,
      ),
    ).rejects.toThrow("carries a different migration identity");
    expect(
      harness.queries.some(({ text }) =>
        /^(?:DROP INDEX|REINDEX INDEX CONCURRENTLY|COMMENT ON INDEX)/.test(
          text,
        ),
      ),
    ).toBe(false);
  });

  test("refuses to reconcile an extension-owned index", async () => {
    const indexes = new Map<string, IndexState>([
      [
        "extension_owned_idx",
        {
          extensionOwned: true,
          live: true,
          marker: null,
          ready: true,
          tableName: "hot_table",
          valid: true,
        },
      ],
    ]);
    const harness = migrationClient({ indexes });

    await expect(
      applyMigration(
        harness.client,
        concurrentMigration([createIndex("extension_owned_idx")]),
        OPTIONS,
      ),
    ).rejects.toThrow("extension-owned");
    expect(
      harness.queries.some(({ text }) =>
        /^(?:ALTER INDEX|DROP INDEX|REINDEX INDEX CONCURRENTLY|COMMENT ON INDEX)/.test(
          text,
        ),
      ),
    ).toBe(false);
    expect(harness.ledgerRows()).toBe(0);
  });

  test("rolls every marker back when the atomic ledger publication fails", async () => {
    const harness = migrationClient({ failLedgerOnce: true });
    const migration = concurrentMigration([
      createIndex("atomic_first_idx"),
      createIndex("atomic_second_idx"),
    ]);

    await expect(
      applyMigration(harness.client, migration, OPTIONS),
    ).rejects.toThrow("simulated ledger publication failure");
    expect(harness.indexes.get("atomic_first_idx")?.marker).toBeNull();
    expect(harness.indexes.get("atomic_second_idx")?.marker).toBeNull();
    expect(harness.ledgerRows()).toBe(0);

    await applyMigration(harness.client, migration, OPTIONS);
    expect(harness.indexes.get("atomic_first_idx")?.marker).toContain(
      "eliza:migration-index:v1:",
    );
    expect(harness.indexes.get("atomic_second_idx")?.marker).toContain(
      "eliza:migration-index:v1:",
    );
    expect(harness.ledgerRows()).toBe(1);
  });

  test("fails closed before querying for missing directives or unsafe SQL", async () => {
    const missingDirective = concurrentMigration([createIndex("missing_idx")]);
    missingDirective.statements[0] = createIndex("missing_idx");
    const unsafe = concurrentMigration([
      createIndex("safe_idx"),
      'DROP TABLE "hot_table"',
    ]);
    const commentLikeLiteral = concurrentMigration([
      `CREATE INDEX CONCURRENTLY "literal_idx" ON "hot_table" (("id"::text || $tag$
-- this physical line is part of the SQL literal
$tag$))`,
    ]);
    const uppercaseIdentifier = concurrentMigration([
      'CREATE INDEX CONCURRENTLY "Upper_idx" ON "hot_table" ("id")',
    ]);
    const longIndexIdentifier = concurrentMigration([
      createIndex("a".repeat(64)),
    ]);
    const longTableIdentifier = concurrentMigration([
      createIndex("long_table_idx", "b".repeat(64)),
    ]);
    const missingHarness = migrationClient();
    const unsafeHarness = migrationClient();
    const literalHarness = migrationClient();
    const uppercaseHarness = migrationClient();
    const longIndexHarness = migrationClient();
    const longTableHarness = migrationClient();

    await expect(
      applyMigration(missingHarness.client, missingDirective, OPTIONS),
    ).rejects.toThrow("without the required nontransactional directive");
    await expect(
      applyMigration(unsafeHarness.client, unsafe, OPTIONS),
    ).rejects.toThrow("permits only CREATE INDEX CONCURRENTLY statements");
    await expect(
      applyMigration(literalHarness.client, commentLikeLiteral, OPTIONS),
    ).rejects.toThrow("unsupported SQL comments");
    await expect(
      applyMigration(uppercaseHarness.client, uppercaseIdentifier, OPTIONS),
    ).rejects.toThrow("requires lowercase quoted index and table identifiers");
    await expect(
      applyMigration(longIndexHarness.client, longIndexIdentifier, OPTIONS),
    ).rejects.toThrow("index identifier exceeds PostgreSQL's 63-byte limit");
    await expect(
      applyMigration(longTableHarness.client, longTableIdentifier, OPTIONS),
    ).rejects.toThrow("table identifier exceeds PostgreSQL's 63-byte limit");
    expect(missingHarness.queries).toEqual([]);
    expect(unsafeHarness.queries).toEqual([]);
    expect(literalHarness.queries).toEqual([]);
    expect(uppercaseHarness.queries).toEqual([]);
    expect(longIndexHarness.queries).toEqual([]);
    expect(longTableHarness.queries).toEqual([]);
  });
});
