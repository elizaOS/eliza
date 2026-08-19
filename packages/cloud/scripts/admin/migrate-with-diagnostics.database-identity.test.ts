/**
 * Proves identity enforcement uses the locked migration session and rejects a
 * mismatched cluster or authority before that session issues any DDL.
 */

import { describe, expect, test } from "bun:test";
import { runMigrations } from "./migrate-with-diagnostics";

const OPTIONS = {
  timeoutMs: 1,
  maxAttempts: 1,
  baseDelayMs: 1,
  maxDelayMs: 1,
};

const IDENTITY_ROW = {
  system_identifier: "7432159876543210000",
  database_name: "staging_database",
  role_name: "staging_role",
  server_version_num: "180002",
};

const MUTATION_PATTERN =
  /\b(?:ALTER|CREATE|DELETE|DROP|INSERT|TRUNCATE|UPDATE)\b/i;

function statefulMigrationClient() {
  const queries: string[] = [];
  let lockHeld = false;
  let ended = false;

  return {
    client: {
      backend: "postgres" as const,
      query: async <T = unknown>(text: string): Promise<{ rows: T[] }> => {
        queries.push(text);
        if (text.includes("pg_advisory_lock")) {
          lockHeld = true;
          return { rows: [] };
        }
        if (text.includes("pg_control_system")) {
          if (!lockHeld) {
            throw new Error("identity query ran outside the migration lock");
          }
          return { rows: [IDENTITY_ROW] as unknown as T[] };
        }
        if (text.includes("pg_advisory_unlock")) {
          lockHeld = false;
          return { rows: [{ unlocked: true }] as unknown as T[] };
        }
        return { rows: [] };
      },
      end: async () => {
        ended = true;
      },
    },
    state: () => ({ ended, lockHeld, queries }),
  };
}

describe("migration-session database identity enforcement", () => {
  for (const mismatch of ["cluster", "authority"] as const) {
    const article = mismatch === "authority" ? "an" : "a";
    test(`rejects ${article} ${mismatch} mismatch before the first DDL`, async () => {
      const harness = statefulMigrationClient();
      const config = {
        environment: "staging" as const,
        mode: "enforce" as const,
        expectedClusterSha256:
          mismatch === "cluster"
            ? "0".repeat(64)
            : "81bfebb15c27ed9707778f3fd9029b0aafe2d71f206ee234ba5f105c63b65e03",
        expectedAuthoritySha256:
          mismatch === "authority"
            ? "1".repeat(64)
            : "8808885f422f805df4781fce4e60e75ecc8e7ab740c90a9793c457d03ff410af",
      };

      await expect(
        runMigrations(harness.client, [], OPTIONS, config),
      ).rejects.toThrow(`database identity mismatch: ${mismatch}`);

      const state = harness.state();
      const lockIndex = state.queries.findIndex((query) =>
        query.includes("pg_advisory_lock"),
      );
      const identityIndex = state.queries.findIndex((query) =>
        query.includes("pg_control_system"),
      );
      const unlockIndex = state.queries.findIndex((query) =>
        query.includes("pg_advisory_unlock"),
      );
      expect(lockIndex).toBeGreaterThan(-1);
      expect(identityIndex).toBeGreaterThan(lockIndex);
      expect(unlockIndex).toBeGreaterThan(identityIndex);
      expect(
        state.queries.filter((query) => MUTATION_PATTERN.test(query)),
      ).toEqual([]);
      expect(state.lockHeld).toBe(false);
      expect(state.ended).toBe(true);
    });
  }
});
