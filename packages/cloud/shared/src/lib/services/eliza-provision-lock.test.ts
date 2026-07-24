/**
 * Pins the SQL contract for bounded Eliza lifecycle transactions.
 */

import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DbTransaction } from "../../db/client";
import { configureElizaLifecycleTransaction } from "./eliza-provision-lock";

describe("configureElizaLifecycleTransaction", () => {
  test("sets transaction-local lock and statement deadlines before advisory work", async () => {
    const statements: SQL[] = [];
    const tx = {
      execute: async (query: SQL) => {
        statements.push(query);
        return { rows: [] } as never;
      },
    } as Pick<DbTransaction, "execute">;

    await configureElizaLifecycleTransaction(tx);

    expect(statements).toHaveLength(1);
    const rendered = new PgDialect().sqlToQuery(statements[0]!);
    expect(rendered.sql).toContain("set_config('lock_timeout'");
    expect(rendered.sql).toContain("set_config('statement_timeout'");
    expect(rendered.sql).toContain("TRUE");
    expect(rendered.params).toEqual(["10000ms", "30000ms"]);
  });
});
