/** Deterministic boundary tests for primary-database clock failures. */

import { expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import type { DbTransaction } from "../client";
import { readPostLockDatabaseNow } from "./primary-database-clock";

test("fails with a typed invariant when the primary clock row is absent", async () => {
  const tx = {
    execute: async () => ({ rows: [] }),
  } as unknown as DbTransaction;
  const clock = readPostLockDatabaseNow(tx);
  await expect(clock).rejects.toBeInstanceOf(ElizaError);
  await expect(clock).rejects.toMatchObject({
    code: "PRIMARY_DATABASE_CLOCK_UNAVAILABLE",
    severity: "fatal",
  });
});
