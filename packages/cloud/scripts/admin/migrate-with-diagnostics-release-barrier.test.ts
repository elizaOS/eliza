/**
 * Proves the temporary usage-quotas release barrier pauses the destructive
 * pair before SQL, repairs ledgers already at 0282, rejects suffix drift, and
 * admits an empty ledger only after a relation-free catalog proof while
 * committing the destructive pair atomically.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  evaluateMigrationReleaseBarrier,
  runMigrations,
} from "./migrate-with-diagnostics";

const CHECKPOINT_TAG = "0194_job_execution_interruptions_catalog_guard";
const DROP_TAG = "0282_drop_unused_usage_quotas_table";
const RESTORE_TAG = "0282_01_restore_usage_quotas_compatibility";
const ROOT = path.resolve(import.meta.dir, "../../../..");
const OPTIONS = {
  timeoutMs: 1,
  maxAttempts: 1,
  baseDelayMs: 1,
  maxDelayMs: 1,
};

function migration(idx: number, tag: string, statement: string) {
  return {
    entry: {
      idx,
      version: "7",
      when: 1_900_000_000_000 + idx,
      tag,
      breakpoints: true,
    },
    hash: `hash-${tag}`,
    statements: [statement],
  };
}

function barrierMigrations() {
  return [
    migration(194, CHECKPOINT_TAG, "SELECT checkpoint"),
    migration(281, "0281_before_usage_quotas_release", "SELECT before_drop"),
    migration(282, DROP_TAG, "DROP TABLE usage_quotas"),
    migration(283, RESTORE_TAG, "CREATE TABLE usage_quotas (id uuid)"),
  ];
}

function appliedRows(
  migrations: ReturnType<typeof barrierMigrations>,
  throughIndex: number,
) {
  return migrations.slice(0, throughIndex + 1).map((source, offset) => ({
    id: offset + 1,
    hash: source.hash,
    created_at: source.entry.when,
  }));
}

function migrationClient(
  applied: ReturnType<typeof appliedRows>,
  options: {
    failOnStatement?: string;
    hasUserRelations?: boolean;
  } = {},
): {
  client: {
    backend: "pglite";
    query<T = unknown>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }>;
    end(): Promise<void>;
  };
  queries: string[];
  queryParams: unknown[][];
  ended: () => boolean;
} {
  const queries: string[] = [];
  const queryParams: unknown[][] = [];
  let didEnd = false;
  return {
    client: {
      backend: "pglite",
      query: async <T = unknown>(
        text: string,
        params?: unknown[],
      ): Promise<{ rows: T[] }> => {
        queries.push(text);
        queryParams.push(params ?? []);
        if (text.includes("AS has_user_relations")) {
          return {
            rows: [
              { has_user_relations: options.hasUserRelations ?? false },
            ] as T[],
          };
        }
        if (text.includes(`FROM "drizzle"."__drizzle_migrations"`)) {
          return { rows: applied as T[] };
        }
        if (options.failOnStatement === text) {
          throw new Error("injected migration failure");
        }
        return { rows: [] };
      },
      end: async () => {
        didEnd = true;
      },
    },
    queries,
    queryParams,
    ended: () => didEnd,
  };
}

describe("usage-quotas migration release barrier", () => {
  test("pauses a validated 0281 ledger before either 0282 or 0282_01 SQL", async () => {
    const migrations = barrierMigrations();
    const harness = migrationClient(appliedRows(migrations, 1));
    let convergenceCalls = 0;
    const outputLog = spyOn(console, "log").mockImplementation(() => {});
    const warningLog = spyOn(console, "warn").mockImplementation(() => {});

    try {
      await runMigrations(
        harness.client,
        migrations,
        OPTIONS,
        undefined,
        undefined,
        async () => {
          convergenceCalls += 1;
        },
      );
    } finally {
      outputLog.mockRestore();
      warningLog.mockRestore();
    }

    expect(harness.queries).not.toContain("BEGIN");
    expect(harness.queries).not.toContain("DROP TABLE usage_quotas");
    expect(harness.queries).not.toContain(
      "CREATE TABLE usage_quotas (id uuid)",
    );
    expect(convergenceCalls).toBe(1);
    expect(harness.ended()).toBe(true);
  });

  test("applies an older ledger's safe prefix then pauses before 0282", async () => {
    const migrations = barrierMigrations();
    const harness = migrationClient(appliedRows(migrations, 0));
    let convergenceCalls = 0;
    const outputLog = spyOn(console, "log").mockImplementation(() => {});
    const warningLog = spyOn(console, "warn").mockImplementation(() => {});

    try {
      await runMigrations(
        harness.client,
        migrations,
        OPTIONS,
        undefined,
        undefined,
        async () => {
          convergenceCalls += 1;
        },
      );
    } finally {
      outputLog.mockRestore();
      warningLog.mockRestore();
    }

    expect(harness.queries).toContain("SELECT before_drop");
    expect(harness.queries).not.toContain("DROP TABLE usage_quotas");
    expect(harness.queries).not.toContain(
      "CREATE TABLE usage_quotas (id uuid)",
    );
    expect(harness.queries.filter((query) => query === "BEGIN")).toHaveLength(
      1,
    );
    expect(harness.queries.filter((query) => query === "COMMIT")).toHaveLength(
      1,
    );
    expect(convergenceCalls).toBe(1);
    expect(harness.ended()).toBe(true);
  });

  test("applies 0282_01 when 0282 is already ledgered", async () => {
    const migrations = barrierMigrations();
    const harness = migrationClient(appliedRows(migrations, 2));
    const outputLog = spyOn(console, "log").mockImplementation(() => {});

    try {
      await runMigrations(harness.client, migrations, OPTIONS);
    } finally {
      outputLog.mockRestore();
    }

    expect(harness.queries).not.toContain("DROP TABLE usage_quotas");
    expect(harness.queries).toContain("CREATE TABLE usage_quotas (id uuid)");
    expect(harness.queries.filter((query) => query === "BEGIN")).toHaveLength(
      1,
    );
    expect(harness.queries.filter((query) => query === "COMMIT")).toHaveLength(
      1,
    );
    expect(harness.ended()).toBe(true);
  });

  // A later migration is none of this barrier's business. Requiring the pair to
  // be the journal TAIL meant the next migration anyone appended made
  // db:migrate throw for every target, including fully-migrated ones — a
  // repo-wide stop-the-world. What must hold is that nothing interleaves
  // BETWEEN the drop and the restore.
  test("allows an unrelated migration appended after the guarded pair", async () => {
    const migrations = [
      ...barrierMigrations(),
      migration(284, "0284_some_future_feature", "SELECT future"),
    ];
    const harness = migrationClient(appliedRows(barrierMigrations(), 3));
    const outputLog = spyOn(console, "log").mockImplementation(() => {});

    try {
      await runMigrations(harness.client, migrations, OPTIONS);
    } finally {
      outputLog.mockRestore();
    }

    expect(harness.queries).toContain("SELECT future");
    expect(harness.ended()).toBe(true);
  });

  test("fails closed when a migration interleaves between the drop and the restore", () => {
    const [checkpoint, before, drop, restore] = barrierMigrations();
    const migrations = [
      checkpoint,
      before,
      drop,
      migration(2825, "0282b_interleaved", "SELECT interleaved"),
      restore,
    ];

    expect(() => evaluateMigrationReleaseBarrier(migrations, 0)).toThrow(
      "adjacent journal entries",
    );
  });

  test("plans a pause at 0282 for any older validated ledger", () => {
    const migrations = barrierMigrations();

    expect(evaluateMigrationReleaseBarrier(migrations, 0)).toEqual({
      action: "pause",
      stopBeforeJournalIndex: 2,
    });
  });

  // The empty-ledger plan explicitly requires atomic execution of the pair;
  // the runner separately proves the database has no application relations.
  test("plans an atomic pair for an empty ledger but still pauses any older validated ledger", () => {
    const migrations = barrierMigrations();

    expect(evaluateMigrationReleaseBarrier(migrations, -1)).toEqual({
      action: "continue",
      atomicPairStartIndex: 2,
    });
    expect(evaluateMigrationReleaseBarrier(migrations, 0)).toEqual({
      action: "pause",
      stopBeforeJournalIndex: 2,
    });
    expect(evaluateMigrationReleaseBarrier(migrations, 1)).toEqual({
      action: "pause",
      stopBeforeJournalIndex: 2,
    });
  });

  // The fresh-ledger carve-out sits behind the structural checks, so a fresh
  // database still refuses a journal whose guarded pair is missing, duplicated,
  // interleaved, or reversed instead of applying it without the barrier.
  test("still validates the guarded pair's shape for an empty ledger", () => {
    const [checkpoint, before, drop, restore] = barrierMigrations();

    expect(() =>
      evaluateMigrationReleaseBarrier(
        [
          checkpoint,
          before,
          drop,
          migration(2825, "0282b_interleaved", "SELECT interleaved"),
          restore,
        ],
        -1,
      ),
    ).toThrow("adjacent journal entries");
    expect(() =>
      evaluateMigrationReleaseBarrier([checkpoint, before, restore, drop], -1),
    ).toThrow("adjacent journal entries");
    expect(() =>
      evaluateMigrationReleaseBarrier([checkpoint, before, drop], -1),
    ).toThrow("requires exactly one of each suffix entry");
    expect(() =>
      evaluateMigrationReleaseBarrier(
        [
          checkpoint,
          before,
          drop,
          restore,
          migration(284, RESTORE_TAG, "SELECT duplicate"),
        ],
        -1,
      ),
    ).toThrow("requires exactly one of each suffix entry");
  });

  test("fails closed when an empty ledger belongs to a nonempty schema", async () => {
    const migrations = barrierMigrations();
    const harness = migrationClient(appliedRows(migrations, -1), {
      hasUserRelations: true,
    });
    const outputLog = spyOn(console, "log").mockImplementation(() => {});
    const errorLog = spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        runMigrations(harness.client, migrations, OPTIONS),
      ).rejects.toThrow(
        "ledger is empty but the database contains application relations",
      );
    } finally {
      outputLog.mockRestore();
      errorLog.mockRestore();
    }

    expect(harness.queries).not.toContain("BEGIN");
    expect(harness.queries).not.toContain("DROP TABLE usage_quotas");
    expect(harness.ended()).toBe(true);
  });

  test("preserves a real nonempty PGlite schema whose ledger was wiped", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = await PGlite.create();
    await db.exec(
      "CREATE TABLE live_data (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO live_data VALUES (1, 'preserve-me')",
    );
    let ended = false;
    const client = {
      backend: "pglite" as const,
      query: async <T = unknown>(text: string, params?: unknown[]) => {
        if (params && params.length > 0) {
          const result = await db.query<T>(text, params);
          return { rows: result.rows };
        }
        const results = await db.exec(text);
        return { rows: (results.at(-1)?.rows as T[] | undefined) ?? [] };
      },
      end: async () => {
        ended = true;
      },
    };
    const outputLog = spyOn(console, "log").mockImplementation(() => {});
    const errorLog = spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        runMigrations(client, barrierMigrations(), OPTIONS),
      ).rejects.toThrow(
        "ledger is empty but the database contains application relations",
      );
      const preserved = await db.query<{ value: string }>(
        "SELECT value FROM live_data WHERE id = 1",
      );
      expect(preserved.rows).toEqual([{ value: "preserve-me" }]);
      expect(ended).toBe(true);
    } finally {
      outputLog.mockRestore();
      errorLog.mockRestore();
      await db.close();
    }
  });

  test("migrates a real relation-free PGlite database through the atomic pair", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = await PGlite.create();
    const client = {
      backend: "pglite" as const,
      query: async <T = unknown>(text: string, params?: unknown[]) => {
        if (params && params.length > 0) {
          const result = await db.query<T>(text, params);
          return { rows: result.rows };
        }
        const results = await db.exec(text);
        return { rows: (results.at(-1)?.rows as T[] | undefined) ?? [] };
      },
      end: async () => {},
    };
    const migrations = barrierMigrations();
    migrations[0] = migration(194, CHECKPOINT_TAG, "SELECT 1");
    migrations[1] = migration(
      281,
      "0281_before_usage_quotas_release",
      "SELECT 2",
    );
    migrations[2] = migration(
      282,
      DROP_TAG,
      "DROP TABLE IF EXISTS usage_quotas",
    );
    const outputLog = spyOn(console, "log").mockImplementation(() => {});

    try {
      await runMigrations(client, migrations, OPTIONS);
      const table = await db.query<{ exists: boolean }>(
        "SELECT to_regclass('public.usage_quotas') IS NOT NULL AS exists",
      );
      expect(table.rows).toEqual([{ exists: true }]);
      const ledger = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations",
      );
      expect(ledger.rows).toEqual([{ count: "4" }]);
    } finally {
      outputLog.mockRestore();
      await db.close();
    }
  });

  // End to end through runMigrations: the drop, restore, and both ledger rows
  // share one transaction. Prefix/suffix migrations keep their own commits.
  test("applies the guarded pair atomically when a relation-free database has an empty ledger", async () => {
    const migrations = [
      ...barrierMigrations(),
      migration(284, "0284_first_future_feature", "SELECT future_one"),
      migration(285, "0285_second_future_feature", "SELECT future_two"),
    ];
    const harness = migrationClient(appliedRows(migrations, -1));
    let convergenceCalls = 0;
    const outputLog = spyOn(console, "log").mockImplementation(() => {});
    const warnings: string[] = [];
    const warningLog = spyOn(console, "warn").mockImplementation(
      (message: string) => {
        warnings.push(message);
      },
    );

    try {
      await runMigrations(
        harness.client,
        migrations,
        OPTIONS,
        undefined,
        undefined,
        async () => {
          convergenceCalls += 1;
        },
      );
    } finally {
      outputLog.mockRestore();
      warningLog.mockRestore();
    }

    const appliedInOrder = [
      ["SELECT checkpoint", CHECKPOINT_TAG],
      ["SELECT before_drop", "0281_before_usage_quotas_release"],
      ["DROP TABLE usage_quotas", DROP_TAG],
      ["CREATE TABLE usage_quotas (id uuid)", RESTORE_TAG],
      ["SELECT future_one", "0284_first_future_feature"],
      ["SELECT future_two", "0285_second_future_feature"],
    ] as const;
    const drop = harness.queries.indexOf("DROP TABLE usage_quotas");
    const restore = harness.queries.indexOf(
      "CREATE TABLE usage_quotas (id uuid)",
    );
    const pairBegin = harness.queries.lastIndexOf("BEGIN", drop);
    const pairCommit = harness.queries.indexOf("COMMIT", restore);
    expect(pairBegin).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThan(pairBegin);
    expect(restore).toBeGreaterThan(drop);
    expect(pairCommit).toBeGreaterThan(restore);
    expect(harness.queries.slice(drop, restore)).not.toContain("COMMIT");
    const pairLedgerParams = harness.queryParams
      .slice(drop, pairCommit)
      .filter((params) => params.length > 0);
    expect(pairLedgerParams).toContainEqual([
      `hash-${DROP_TAG}`,
      expect.any(Number),
    ]);
    expect(pairLedgerParams).toContainEqual([
      `hash-${RESTORE_TAG}`,
      expect.any(Number),
    ]);
    expect(harness.queries.filter((query) => query === "BEGIN")).toHaveLength(
      appliedInOrder.length - 1,
    );
    expect(harness.queries.filter((query) => query === "COMMIT")).toHaveLength(
      appliedInOrder.length - 1,
    );
    // Journal order end to end, with the restore directly after the drop.
    const statements = new Set(migrations.flatMap((item) => item.statements));
    expect(harness.queries.filter((query) => statements.has(query))).toEqual(
      appliedInOrder.map(([statement]) => statement),
    );
    expect(
      warnings.some((message) => message.includes("release barrier paused")),
    ).toBe(false);
    expect(convergenceCalls).toBe(1);
    expect(harness.ended()).toBe(true);
  });

  test("rolls back both guarded entries when the restore fails", async () => {
    const migrations = barrierMigrations();
    const harness = migrationClient(appliedRows(migrations, -1), {
      failOnStatement: "CREATE TABLE usage_quotas (id uuid)",
    });
    const outputLog = spyOn(console, "log").mockImplementation(() => {});
    const errorLog = spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        runMigrations(harness.client, migrations, OPTIONS),
      ).rejects.toThrow("injected migration failure");
    } finally {
      outputLog.mockRestore();
      errorLog.mockRestore();
    }

    const drop = harness.queries.indexOf("DROP TABLE usage_quotas");
    const restore = harness.queries.indexOf(
      "CREATE TABLE usage_quotas (id uuid)",
    );
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(restore).toBeGreaterThan(drop);
    expect(harness.queries.indexOf("ROLLBACK", restore)).toBeGreaterThan(
      restore,
    );
    expect(harness.queries.slice(drop, restore)).not.toContain("COMMIT");
    expect(harness.ended()).toBe(true);
  });

  test("fails closed when either guarded migration is missing or duplicated", () => {
    const migrations = barrierMigrations();

    expect(() =>
      evaluateMigrationReleaseBarrier(migrations.slice(0, -1), 1),
    ).toThrow("requires exactly one of each suffix entry");
    expect(() =>
      evaluateMigrationReleaseBarrier(
        [...migrations, migration(284, RESTORE_TAG, "SELECT duplicate")],
        1,
      ),
    ).toThrow("requires exactly one of each suffix entry");
  });

  test("keeps the release workflow and package scripts on the guarded runner", async () => {
    const workflow = await readFile(
      path.join(ROOT, ".github/workflows/cloud-cf-release.yml"),
      "utf8",
    );
    const runMigrationsStep = workflow.match(
      /- name: Run migrations[\s\S]*?(?=\n {6}- name:|\n {2}[a-z0-9_-]+:)/,
    )?.[0];
    const deployApiJob = workflow.match(
      /\n {2}deploy-api:\n[\s\S]*?(?=\n {2}[a-z0-9_-]+:\n)/,
    )?.[0];
    const cloudSharedPackage = JSON.parse(
      await readFile(
        path.join(ROOT, "packages/cloud/shared/package.json"),
        "utf8",
      ),
    ) as { scripts?: Record<string, string> };
    const rootPackage = JSON.parse(
      await readFile(path.join(ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const journal = JSON.parse(
      await readFile(
        path.join(
          ROOT,
          "packages/cloud/shared/src/db/migrations/meta/_journal.json",
        ),
        "utf8",
      ),
    ) as { entries?: Array<{ tag?: string }> };

    expect(runMigrationsStep).toContain("bun run db:cloud:migrate");
    expect(deployApiJob).toMatch(/^ {4}needs: migrate-db$/m);
    expect(rootPackage.scripts?.["db:cloud:migrate"]).toContain(
      "packages/cloud/scripts/admin/migrate-with-diagnostics.ts",
    );
    expect(cloudSharedPackage.scripts?.["db:migrate:drizzle"]).toBe(
      "bun run db:migrate",
    );
    expect(cloudSharedPackage.scripts?.["db:migrate:drizzle"]).not.toContain(
      "drizzle-kit migrate",
    );
    // Adjacency, not tail position. Pinning the pair to the end of the journal
    // is the same mistake the barrier itself used to make: it turns the next
    // migration anyone appends into a repo-wide failure. What must hold is that
    // the restore immediately follows the drop, so nothing can interleave.
    const tags = journal.entries?.map((entry) => entry.tag) ?? [];
    const dropAt = tags.indexOf(DROP_TAG);
    expect(dropAt).toBeGreaterThanOrEqual(0);
    expect(tags[dropAt + 1]).toBe(RESTORE_TAG);
  });

  // A ledger sitting exactly at 0282 must repair forward: the restore runs
  // first, every later migration follows in journal order, and the already-
  // applied drop never executes again. Requiring the pair to be the journal
  // tail here would push the stop-the-world failure onto the first ledger
  // that adopts any future migration.
  test("applies the restore then later migrations when 0282 is ledgered with future suffixes", async () => {
    const migrations = [
      ...barrierMigrations(),
      migration(284, "0284_first_future_feature", "SELECT future_one"),
      migration(285, "0285_second_future_feature", "SELECT future_two"),
    ];
    const harness = migrationClient(appliedRows(barrierMigrations(), 2));
    let convergenceCalls = 0;
    const outputLog = spyOn(console, "log").mockImplementation(() => {});

    try {
      await runMigrations(
        harness.client,
        migrations,
        OPTIONS,
        undefined,
        undefined,
        async () => {
          convergenceCalls += 1;
        },
      );
    } finally {
      outputLog.mockRestore();
    }

    expect(harness.queries).not.toContain("DROP TABLE usage_quotas");
    // Each applied migration is individually ledgered in journal order: the
    // statements run inside their own transaction and the ledger INSERT
    // carries the migration's hash before the COMMIT.
    const appliedInOrder = [
      ["CREATE TABLE usage_quotas (id uuid)", RESTORE_TAG],
      ["SELECT future_one", "0284_first_future_feature"],
      ["SELECT future_two", "0285_second_future_feature"],
    ] as const;
    let searchFrom = 0;
    for (const [statement, tag] of appliedInOrder) {
      const begin = harness.queries.indexOf("BEGIN", searchFrom);
      const run = harness.queries.indexOf(statement, searchFrom);
      const ledgered = harness.queries.findIndex(
        (query, index) =>
          index > run &&
          query.includes("INSERT INTO") &&
          query.includes("__drizzle_migrations"),
      );
      const commit = harness.queries.indexOf("COMMIT", ledgered);
      expect(begin).toBeGreaterThanOrEqual(0);
      expect(run).toBeGreaterThan(begin);
      expect(ledgered).toBeGreaterThan(run);
      expect(commit).toBeGreaterThan(ledgered);
      expect(harness.queryParams[ledgered]).toContain(`hash-${tag}`);
      searchFrom = commit + 1;
    }
    expect(harness.queries.filter((query) => query === "BEGIN")).toHaveLength(
      3,
    );
    expect(harness.queries.filter((query) => query === "COMMIT")).toHaveLength(
      3,
    );
    expect(convergenceCalls).toBe(1);
    expect(harness.ended()).toBe(true);
  });

  // Future suffixes behind the barrier must not unlock the guarded pair: an
  // older ledger still pauses before the drop, never touching the restore or
  // anything appended after it, and still reports the pause to the operator.
  test("still pauses before the guarded pair when an older ledger has future suffixes pending", async () => {
    const migrations = [
      ...barrierMigrations(),
      migration(284, "0284_pending_future_feature", "SELECT pending_future"),
    ];
    const harness = migrationClient(appliedRows(barrierMigrations(), 1));
    let convergenceCalls = 0;
    const barrierEvents: string[] = [];
    const outputLog = spyOn(console, "log").mockImplementation(() => {});
    const warningLog = spyOn(console, "warn").mockImplementation(
      (message: string) => {
        if (message.includes("release barrier paused")) {
          barrierEvents.push("warning");
        }
      },
    );

    try {
      await runMigrations(
        harness.client,
        migrations,
        OPTIONS,
        undefined,
        undefined,
        async () => {
          convergenceCalls += 1;
          barrierEvents.push("convergence");
        },
      );
    } finally {
      outputLog.mockRestore();
      warningLog.mockRestore();
    }

    expect(harness.queries).not.toContain("BEGIN");
    expect(harness.queries).not.toContain("DROP TABLE usage_quotas");
    expect(harness.queries).not.toContain(
      "CREATE TABLE usage_quotas (id uuid)",
    );
    expect(harness.queries).not.toContain("SELECT pending_future");
    expect(convergenceCalls).toBe(1);
    // Convergence must finish before the pause is reported, so the schema is
    // consistent when the operator reads the warning.
    expect(barrierEvents).toEqual(["convergence", "warning"]);
    expect(harness.ended()).toBe(true);
  });

  // A ledger that has already adopted a future suffix is fully migrated: the
  // run is a no-op for migration SQL, yet still converges the schema and
  // closes the client - and critically never reruns the drop or the restore.
  test("no-ops when the ledger is already past a future suffix", async () => {
    const migrations = [
      ...barrierMigrations(),
      migration(284, "0284_adopted_future_feature", "SELECT adopted_future"),
    ];
    const harness = migrationClient(appliedRows(migrations, 4));
    let convergenceCalls = 0;
    const outputLog = spyOn(console, "log").mockImplementation(() => {});

    try {
      await runMigrations(
        harness.client,
        migrations,
        OPTIONS,
        undefined,
        undefined,
        async () => {
          convergenceCalls += 1;
        },
      );
    } finally {
      outputLog.mockRestore();
    }

    expect(harness.queries).not.toContain("BEGIN");
    expect(harness.queries).not.toContain("DROP TABLE usage_quotas");
    expect(harness.queries).not.toContain(
      "CREATE TABLE usage_quotas (id uuid)",
    );
    expect(harness.queries).not.toContain("SELECT adopted_future");
    expect(convergenceCalls).toBe(1);
    expect(harness.ended()).toBe(true);
  });

  // Journal order is part of the guarded contract, not just adjacency count:
  // a restore indexed before the drop fails closed instead of "repairing"
  // backwards.
  test("fails closed when the restore is journal-indexed before the drop", () => {
    const [checkpoint, before, drop, restore] = barrierMigrations();
    const migrations = [checkpoint, before, restore, drop];

    expect(() => evaluateMigrationReleaseBarrier(migrations, 1)).toThrow(
      "adjacent journal entries",
    );
  });
});
