/**
 * Proves the temporary usage-quotas release barrier pauses the destructive
 * pair before SQL on PostgreSQL (an empty ledger included), repairs ledgers
 * already at 0282, rejects suffix drift, and lets the local-only PGlite
 * backend apply the whole journal from any ledger position, including a run
 * resumed after an interruption before 0282.
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

type MigrationBackend = "pglite" | "postgres";

/**
 * Snapshot ledger client. Models PostgreSQL by default, the served backend
 * whose pause semantics these tests pin; pass "pglite" to exercise the
 * local-only backend.
 */
function migrationClient(
  applied: ReturnType<typeof appliedRows>,
  backend: MigrationBackend = "postgres",
): {
  client: {
    backend: MigrationBackend;
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
      backend,
      query: async <T = unknown>(
        text: string,
        params?: unknown[],
      ): Promise<{ rows: T[] }> => {
        queries.push(text);
        queryParams.push(params ?? []);
        if (text.includes(`FROM "drizzle"."__drizzle_migrations"`)) {
          return { rows: applied as T[] };
        }
        if (text.includes("pg_advisory_unlock")) {
          return { rows: [{ unlocked: true }] as T[] };
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

interface DurableLedgerClientOptions {
  backend: MigrationBackend;
  /** Throw at this statement, simulating a crash in the middle of a run. */
  crashAt?: string;
}

/**
 * Ledger that survives across runMigrations invocations so a second run sees
 * what the first one committed: the ledger INSERT stages a row, COMMIT keeps
 * it, ROLLBACK discards it, and the ledger SELECT returns the kept rows.
 */
function durableLedger() {
  const rows: Array<{ id: number; hash: string; created_at: number }> = [];
  return {
    rows,
    client(options: DurableLedgerClientOptions) {
      const queries: string[] = [];
      let staged: { hash: string; created_at: number } | undefined;
      let didEnd = false;
      return {
        client: {
          backend: options.backend,
          query: async <T = unknown>(
            text: string,
            params?: unknown[],
          ): Promise<{ rows: T[] }> => {
            queries.push(text);
            if (text === options.crashAt) {
              throw new Error(`simulated crash at ${text}`);
            }
            if (text.includes(`FROM "drizzle"."__drizzle_migrations"`)) {
              return { rows: rows.map((row) => ({ ...row })) as T[] };
            }
            if (
              text.includes("INSERT INTO") &&
              text.includes("__drizzle_migrations")
            ) {
              staged = {
                hash: String(params?.[0]),
                created_at: Number(params?.[1]),
              };
            } else if (text === "COMMIT" && staged) {
              rows.push({ id: rows.length + 1, ...staged });
              staged = undefined;
            } else if (text === "ROLLBACK") {
              staged = undefined;
            } else if (text.includes("pg_advisory_unlock")) {
              return { rows: [{ unlocked: true }] as T[] };
            }
            return { rows: [] };
          },
          end: async () => {
            didEnd = true;
          },
        },
        queries,
        ended: () => didEnd,
      };
    },
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

  // The barrier protects a served deployment, and the bypass is scoped by the
  // backend the operator selected, never inferred from the ledger. PGlite is
  // the local-only backend: it continues from any position, fresh or resumed
  // after a run that stopped before the drop. PostgreSQL pauses at every
  // position before the drop, an empty ledger included, until the Phase B/
  // operator contract of #23829 supplies a durable bootstrap authority.
  test("scopes the bypass to the local-only PGlite backend and keeps PostgreSQL failing closed", () => {
    const migrations = barrierMigrations();
    const pause = { action: "pause", stopBeforeJournalIndex: 2 } as const;

    for (const lastApplied of [-1, 0, 1]) {
      expect(
        evaluateMigrationReleaseBarrier(migrations, lastApplied, {
          backend: "pglite",
        }),
      ).toEqual({ action: "continue" });
      expect(
        evaluateMigrationReleaseBarrier(migrations, lastApplied, {
          backend: "postgres",
        }),
      ).toEqual(pause);
    }
    for (const lastApplied of [2, 3]) {
      expect(
        evaluateMigrationReleaseBarrier(migrations, lastApplied, {
          backend: "pglite",
        }),
      ).toEqual({ action: "continue" });
      expect(
        evaluateMigrationReleaseBarrier(migrations, lastApplied, {
          backend: "postgres",
        }),
      ).toEqual({ action: "continue" });
    }
    // An unstated authority is PostgreSQL, the fail-closed default.
    expect(evaluateMigrationReleaseBarrier(migrations, -1)).toEqual(pause);
  });

  // The bypass sits behind the structural checks, so neither backend applies
  // a journal whose guarded pair is missing, duplicated, interleaved, or
  // reversed, from a fresh ledger or an older one.
  test("still validates the guarded pair's shape for both backends", () => {
    const [checkpoint, before, drop, restore] = barrierMigrations();

    for (const backend of ["pglite", "postgres"] as const) {
      for (const lastApplied of [-1, 0]) {
        expect(() =>
          evaluateMigrationReleaseBarrier(
            [
              checkpoint,
              before,
              drop,
              migration(2825, "0282b_interleaved", "SELECT interleaved"),
              restore,
            ],
            lastApplied,
            { backend },
          ),
        ).toThrow("adjacent journal entries");
        expect(() =>
          evaluateMigrationReleaseBarrier(
            [checkpoint, before, restore, drop],
            lastApplied,
            { backend },
          ),
        ).toThrow("adjacent journal entries");
        expect(() =>
          evaluateMigrationReleaseBarrier(
            [checkpoint, before, drop],
            lastApplied,
            {
              backend,
            },
          ),
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
            lastApplied,
            { backend },
          ),
        ).toThrow("requires exactly one of each suffix entry");
      }
    }
  });

  // End to end through runMigrations: an empty PGlite ledger applies every
  // journal entry in order, the drop immediately followed by the restore and
  // then the later suffixes, each individually ledgered, with no pause.
  test("applies the whole journal from an empty PGlite ledger, including 0282, 0282_01, and later suffixes", async () => {
    const migrations = [
      ...barrierMigrations(),
      migration(284, "0284_first_future_feature", "SELECT future_one"),
      migration(285, "0285_second_future_feature", "SELECT future_two"),
    ];
    const harness = migrationClient(appliedRows(migrations, -1), "pglite");
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
      appliedInOrder.length,
    );
    expect(harness.queries.filter((query) => query === "COMMIT")).toHaveLength(
      appliedInOrder.length,
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

  // Restart safety: the barrier decides once per run from the persisted ledger
  // tip. A fresh PGlite run that stops after ledgering a pre-0282 migration
  // must not leave behind a ledger the next run pauses on forever.
  test("resumes a PGlite run interrupted before 0282 and completes the whole journal", async () => {
    const migrations = [
      ...barrierMigrations(),
      migration(284, "0284_first_future_feature", "SELECT future_one"),
    ];
    const ledger = durableLedger();
    const warnings: string[] = [];
    const outputLog = spyOn(console, "log").mockImplementation(() => {});
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    const warningLog = spyOn(console, "warn").mockImplementation(
      (message: string) => {
        warnings.push(message);
      },
    );

    try {
      const interrupted = ledger.client({
        backend: "pglite",
        crashAt: "SELECT before_drop",
      });
      await expect(
        runMigrations(interrupted.client, migrations, OPTIONS),
      ).rejects.toThrow("simulated crash at SELECT before_drop");
      expect(ledger.rows.map((row) => row.hash)).toEqual([
        `hash-${CHECKPOINT_TAG}`,
      ]);
      expect(interrupted.queries).toContain("ROLLBACK");
      expect(interrupted.queries).not.toContain("DROP TABLE usage_quotas");
      expect(interrupted.ended()).toBe(true);

      const resumed = ledger.client({ backend: "pglite" });
      let convergenceCalls = 0;
      await runMigrations(
        resumed.client,
        migrations,
        OPTIONS,
        undefined,
        undefined,
        async () => {
          convergenceCalls += 1;
        },
      );

      const statements = new Set(migrations.flatMap((item) => item.statements));
      expect(resumed.queries.filter((query) => statements.has(query))).toEqual([
        "SELECT before_drop",
        "DROP TABLE usage_quotas",
        "CREATE TABLE usage_quotas (id uuid)",
        "SELECT future_one",
      ]);
      expect(ledger.rows.map((row) => row.hash)).toEqual([
        `hash-${CHECKPOINT_TAG}`,
        "hash-0281_before_usage_quotas_release",
        `hash-${DROP_TAG}`,
        `hash-${RESTORE_TAG}`,
        "hash-0284_first_future_feature",
      ]);
      expect(convergenceCalls).toBe(1);
      expect(resumed.ended()).toBe(true);
    } finally {
      outputLog.mockRestore();
      errorLog.mockRestore();
      warningLog.mockRestore();
    }

    expect(
      warnings.some((message) => message.includes("release barrier paused")),
    ).toBe(false);
  });

  // PostgreSQL is unchanged: a fresh ledger applies the safe prefix and pauses,
  // and every later invocation pauses again without touching the guarded pair.
  test("keeps a fresh PostgreSQL ledger paused before 0282 across invocations", async () => {
    const migrations = barrierMigrations();
    const ledger = durableLedger();
    const warnings: string[] = [];
    const outputLog = spyOn(console, "log").mockImplementation(() => {});
    const warningLog = spyOn(console, "warn").mockImplementation(
      (message: string) => {
        warnings.push(message);
      },
    );

    try {
      const first = ledger.client({ backend: "postgres" });
      await runMigrations(first.client, migrations, OPTIONS);
      expect(first.queries).toContain(
        "SELECT pg_advisory_lock(hashtextextended($1, 0))",
      );
      expect(first.queries).toContain("SELECT checkpoint");
      expect(first.queries).toContain("SELECT before_drop");
      expect(first.queries).not.toContain("DROP TABLE usage_quotas");
      expect(ledger.rows.map((row) => row.hash)).toEqual([
        `hash-${CHECKPOINT_TAG}`,
        "hash-0281_before_usage_quotas_release",
      ]);
      expect(first.ended()).toBe(true);

      const second = ledger.client({ backend: "postgres" });
      await runMigrations(second.client, migrations, OPTIONS);
      expect(second.queries).not.toContain("BEGIN");
      expect(second.queries).not.toContain("DROP TABLE usage_quotas");
      expect(second.queries).not.toContain(
        "CREATE TABLE usage_quotas (id uuid)",
      );
      expect(ledger.rows).toHaveLength(2);
      expect(second.ended()).toBe(true);
    } finally {
      outputLog.mockRestore();
      warningLog.mockRestore();
    }

    expect(
      warnings.filter((message) => message.includes("release barrier paused")),
    ).toHaveLength(2);
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
