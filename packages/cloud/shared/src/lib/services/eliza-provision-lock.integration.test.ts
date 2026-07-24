/**
 * Exercises the lifecycle advisory-lock deadline against two real PostgreSQL sessions.
 * PGlite and statement mocks cannot reproduce cross-session lock contention.
 */

import { afterAll, describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Client } from "pg";
import type { DbTransaction } from "../../db/client";
import {
  configureElizaLifecycleTransaction,
  elizaProvisionAdvisoryLockSql,
} from "./eliza-provision-lock";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "./tenant-db/__tests__/ephemeral-postgres";

const SKIP_REASON =
  "[Eliza lifecycle lock deadline] SKIPPED — no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";

const postgres: EphemeralPostgres | null = await acquireEphemeralPostgres();
if (!postgres) {
  console.warn(SKIP_REASON);
}

afterAll(async () => {
  await postgres?.stop();
});

const realPostgres = postgres ? describe : describe.skip;

function transactionExecutor(client: Client): Pick<DbTransaction, "execute"> {
  const dialect = new PgDialect();
  return {
    execute: async (query: SQL) => {
      const rendered = dialect.sqlToQuery(query);
      const result = await client.query(rendered.sql, rendered.params);
      return { rows: result.rows } as never;
    },
  };
}

realPostgres("Eliza lifecycle transaction deadlines", () => {
  test("a contending advisory lock times out transaction-locally and the session remains reusable", async () => {
    if (!postgres) throw new Error("real PostgreSQL was not acquired");
    const holder = new Client({ connectionString: postgres.dsn });
    const contender = new Client({ connectionString: postgres.dsn });
    await Promise.all([holder.connect(), contender.connect()]);

    try {
      const baselineLockTimeout = await contender.query<{ lock_timeout: string }>(
        "SHOW lock_timeout",
      );
      const baselineStatementTimeout = await contender.query<{ statement_timeout: string }>(
        "SHOW statement_timeout",
      );
      await holder.query("BEGIN");
      await contender.query("BEGIN");
      const lock = elizaProvisionAdvisoryLockSql("deadline-org", "deadline-agent");
      await transactionExecutor(holder).execute(lock);
      await configureElizaLifecycleTransaction(transactionExecutor(contender));

      const lockTimeout = await contender.query<{ lock_timeout: string }>("SHOW lock_timeout");
      const statementTimeout = await contender.query<{ statement_timeout: string }>(
        "SHOW statement_timeout",
      );
      expect(lockTimeout.rows[0]?.lock_timeout).toBe("10s");
      expect(statementTimeout.rows[0]?.statement_timeout).toBe("30s");

      const startedAt = Date.now();
      await expect(transactionExecutor(contender).execute(lock)).rejects.toMatchObject({
        code: "55P03",
      });
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(9_000);
      expect(elapsedMs).toBeLessThan(20_000);

      await contender.query("ROLLBACK");
      expect(
        (await contender.query<{ lock_timeout: string }>("SHOW lock_timeout")).rows[0]
          ?.lock_timeout,
      ).toBe(baselineLockTimeout.rows[0]?.lock_timeout);
      expect(
        (await contender.query<{ statement_timeout: string }>("SHOW statement_timeout")).rows[0]
          ?.statement_timeout,
      ).toBe(baselineStatementTimeout.rows[0]?.statement_timeout);

      await holder.query("ROLLBACK");
      await contender.query("BEGIN");
      await configureElizaLifecycleTransaction(transactionExecutor(contender));
      await expect(transactionExecutor(contender).execute(lock)).resolves.toMatchObject({
        rows: expect.any(Array),
      });
      await contender.query("ROLLBACK");
    } finally {
      await Promise.allSettled([holder.query("ROLLBACK"), contender.query("ROLLBACK")]);
      await Promise.allSettled([holder.end(), contender.end()]);
    }
  }, 30_000);
});
