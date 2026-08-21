/**
 * Proves the temporary usage-quotas release barrier pauses the destructive
 * pair before SQL, repairs ledgers already at 0282, and rejects suffix drift.
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

function migrationClient(applied: ReturnType<typeof appliedRows>): {
  client: {
    backend: "pglite";
    query<T = unknown>(text: string): Promise<{ rows: T[] }>;
    end(): Promise<void>;
  };
  queries: string[];
  ended: () => boolean;
} {
  const queries: string[] = [];
  let didEnd = false;
  return {
    client: {
      backend: "pglite",
      query: async <T = unknown>(text: string): Promise<{ rows: T[] }> => {
        queries.push(text);
        if (text.includes(`FROM "drizzle"."__drizzle_migrations"`)) {
          return { rows: applied as T[] };
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
    expect(journal.entries?.slice(-2).map((entry) => entry.tag)).toEqual([
      DROP_TAG,
      RESTORE_TAG,
    ]);
  });
});
