/** Post-lock primary-database clock authority for lease decisions. */

import { ElizaError } from "@elizaos/core";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { sqlRows } from "../execute-helpers";

export async function readPostLockDatabaseNow(tx: DbTransaction): Promise<Date> {
  const [clock] = await sqlRows<{ database_now: Date | string }>(
    tx,
    sql`SELECT clock_timestamp() AS database_now`,
  );
  const databaseNow =
    clock?.database_now instanceof Date
      ? clock.database_now
      : new Date(clock?.database_now ?? Number.NaN);
  if (!Number.isFinite(databaseNow.getTime())) {
    throw new ElizaError("Primary database clock is unavailable", {
      code: "PRIMARY_DATABASE_CLOCK_UNAVAILABLE",
      severity: "fatal",
    });
  }
  return databaseNow;
}
