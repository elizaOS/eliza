/**
 * Verifies the migration runner checks database identity on its locked
 * PostgreSQL session before issuing any schema mutation.
 */

import { expect, spyOn, test } from "bun:test";
import { runMigrations } from "./migrate-with-diagnostics";

const OPTIONS = {
  timeoutMs: 1,
  maxAttempts: 1,
  baseDelayMs: 1,
  maxDelayMs: 1,
};

test("an identity mismatch on the migration session prevents all DDL", async () => {
  const queries: string[] = [];
  const client = {
    backend: "postgres" as const,
    query: async <T = unknown>(text: string): Promise<{ rows: T[] }> => {
      queries.push(text);
      if (text.includes("pg_catalog.pg_control_system()")) {
        return {
          rows: [
            {
              system_identifier: "7432159876543210000",
              database_name: "unexpected_database",
              role_name: "unexpected_role",
              server_version_num: "180002",
            },
          ] as T[],
        };
      }
      if (text.includes("pg_advisory_unlock")) {
        return { rows: [{ unlocked: true }] as T[] };
      }
      return { rows: [] };
    },
    end: async () => {},
  };
  const outputLog = spyOn(console, "log").mockImplementation(() => {});

  try {
    await expect(
      runMigrations(client, [], OPTIONS, {
        environment: "staging",
        mode: "enforce",
        expectedClusterSha256: "0".repeat(64),
        expectedAuthoritySha256: "1".repeat(64),
      }),
    ).rejects.toThrow("database identity mismatch: cluster,authority");
  } finally {
    outputLog.mockRestore();
  }

  const identityQueryIndex = queries.findIndex((query) =>
    query.includes("pg_catalog.pg_control_system()"),
  );
  const lockQueryIndex = queries.findIndex((query) =>
    query.includes("pg_advisory_lock"),
  );
  expect(identityQueryIndex).toBeGreaterThan(lockQueryIndex);
  expect(
    queries.some((query) =>
      /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(query),
    ),
  ).toBe(false);
});
