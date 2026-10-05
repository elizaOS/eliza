/**
 * `bun run db:generate` serializes the full Drizzle schema to a JSON snapshot.
 * JavaScript BigInt defaults cannot be JSON-serialized, so any `.default(0n)`
 * on a bigint column breaks migration generation (#31523). This runs the same
 * drizzle-kit snapshot builder over every exported schema and pins the
 * database defaults that used to be BigInt literals.
 */
import { expect, test } from "bun:test";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import * as schema from "./schemas";

test("the full cloud schema serializes to a drizzle-kit snapshot and DDL", async () => {
  const snapshot = generateDrizzleJson(schema as Record<string, unknown>);
  expect(() => JSON.stringify(snapshot)).not.toThrow();

  const ddl = (await generateMigration(generateDrizzleJson({}), snapshot)).join("\n");
  for (const column of [
    '"access_count" bigint DEFAULT 0 NOT NULL',
    '"policy_generation" bigint DEFAULT 0 NOT NULL',
    '"generation" bigint DEFAULT 0 NOT NULL',
    '"size_bytes" bigint DEFAULT 0 NOT NULL',
    '"last_turn" bigint DEFAULT 0 NOT NULL',
    '"bytes_used" bigint DEFAULT 0 NOT NULL',
    '"bytes_limit" bigint DEFAULT 5368709120 NOT NULL',
  ])
    expect(ddl).toContain(column);
});
