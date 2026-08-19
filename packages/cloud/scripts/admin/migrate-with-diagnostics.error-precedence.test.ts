/**
 * Exercises the migration retry boundary with a failed rollback so connection
 * cleanup cannot hide the database error or start an unsafe second attempt.
 */

import { expect, spyOn, test } from "bun:test";
import {
  applyMigration,
  convergeAgentSandboxSchemaOnMigrationClient,
  runMigrations,
} from "./migrate-with-diagnostics";

const OPTIONS = {
  timeoutMs: 1,
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 1,
};

test("a rollback failure preserves the migration error and prevents retry", async () => {
  const primary = Object.assign(new Error("lock timeout"), { code: "55P03" });
  const rollback = Object.assign(new Error("connection lost during rollback"), {
    code: "08006",
  });
  const queries: string[] = [];
  const client = {
    backend: "postgres" as const,
    query: async <T = unknown>(text: string): Promise<{ rows: T[] }> => {
      queries.push(text);
      if (text === "SELECT blocked") throw primary;
      if (text === "ROLLBACK") throw rollback;
      return { rows: [] };
    },
    end: async () => {},
  };
  const migration = {
    entry: {
      idx: 999,
      version: "7",
      when: 1_900_000_000_000,
      tag: "test_lock_timeout",
      breakpoints: true,
    },
    hash: "test-hash",
    statements: ["SELECT blocked"],
  };
  const outputLog = spyOn(console, "log").mockImplementation(() => {});
  const errorLog = spyOn(console, "error").mockImplementation(() => {});

  try {
    await expect(applyMigration(client, migration, OPTIONS)).rejects.toBe(
      primary,
    );
  } finally {
    outputLog.mockRestore();
    errorLog.mockRestore();
  }

  expect(queries.filter((query) => query === "BEGIN")).toHaveLength(1);
  expect(queries.filter((query) => query === "SELECT blocked")).toHaveLength(1);
  expect(queries.filter((query) => query === "ROLLBACK")).toHaveLength(1);
});

test("unlock and close failures cannot replace the migration failure", async () => {
  const primary = new Error("migration catalog unavailable");
  const unlock = new Error("advisory unlock failed");
  const close = new Error("client close failed");
  const queries: string[] = [];
  const logs: string[] = [];
  const client = {
    backend: "postgres" as const,
    query: async <T = unknown>(text: string): Promise<{ rows: T[] }> => {
      queries.push(text);
      if (text.includes("CREATE SCHEMA")) throw primary;
      if (text.includes("pg_advisory_unlock")) throw unlock;
      return { rows: [] };
    },
    end: async () => {
      throw close;
    },
  };
  const outputLog = spyOn(console, "log").mockImplementation(() => {});
  const errorLog = spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => logs.push(args.map(String).join(" ")),
  );

  try {
    await expect(runMigrations(client, [], OPTIONS)).rejects.toBe(primary);
  } finally {
    outputLog.mockRestore();
    errorLog.mockRestore();
  }

  expect(queries.some((query) => query.includes("pg_advisory_unlock"))).toBe(
    true,
  );
  expect(
    logs.some((line) => line.includes("migration advisory unlock failed")),
  ).toBe(true);
  expect(
    logs.some((line) => line.includes("database client close failed")),
  ).toBe(true);
  expect(
    logs.filter((line) =>
      line.includes("preserving the primary migration failure"),
    ),
  ).toHaveLength(2);
});

test("deploy-time convergence runs before success and fails the migration gate closed", async () => {
  const convergenceFailure = new Error("agent-sandbox schema did not converge");
  const queries: string[] = [];
  let convergenceCalls = 0;
  const client = {
    backend: "postgres" as const,
    query: async <T = unknown>(text: string): Promise<{ rows: T[] }> => {
      queries.push(text);
      if (text.includes("pg_advisory_unlock")) {
        return { rows: [{ unlocked: true }] as T[] };
      }
      return { rows: [] };
    },
    end: async () => {},
  };
  const outputLog = spyOn(console, "log").mockImplementation(() => {});
  const checkpointMigration = {
    entry: {
      idx: 194,
      version: "7",
      when: 1_900_000_000_194,
      tag: "0194_job_execution_interruptions_catalog_guard",
      breakpoints: true,
    },
    hash: "checkpoint-hash",
    statements: ["SELECT 1"],
  };

  try {
    await expect(
      runMigrations(
        client,
        [checkpointMigration],
        OPTIONS,
        undefined,
        undefined,
        async (lockedClient) => {
          convergenceCalls += 1;
          expect(lockedClient).toBe(client);
          expect(
            queries.some((query) => query.includes("pg_advisory_lock")),
          ).toBe(true);
          expect(
            queries.some((query) => query.includes("pg_advisory_unlock")),
          ).toBe(false);
          throw convergenceFailure;
        },
      ),
    ).rejects.toBe(convergenceFailure);
  } finally {
    outputLog.mockRestore();
  }

  expect(convergenceCalls).toBe(1);
  expect(queries.some((query) => query.includes("CREATE SCHEMA"))).toBe(true);
  expect(queries.some((query) => query.includes("pg_advisory_unlock"))).toBe(
    true,
  );
});

test("the migration-session adapter executes the complete convergence batch", async () => {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  const client = {
    backend: "postgres" as const,
    query: async <T = unknown>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }> => {
      queries.push({ text, params });
      return { rows: [] };
    },
    end: async () => {},
  };

  await convergeAgentSandboxSchemaOnMigrationClient(client);

  expect(queries.length).toBeGreaterThan(30);
  expect(
    queries.some(({ text }) => text.includes('ALTER TABLE "agent_sandboxes"')),
  ).toBe(true);
  expect(
    queries.some(({ text }) =>
      text.includes('CREATE TABLE IF NOT EXISTS "agent_sandbox_backups"'),
    ),
  ).toBe(true);
  expect(
    queries.some(({ text }) =>
      text.includes('CREATE TABLE IF NOT EXISTS "agent_pairing_tokens"'),
    ),
  ).toBe(true);
});
