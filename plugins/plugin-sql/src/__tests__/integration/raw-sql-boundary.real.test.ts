/**
 * Proves the shared raw-SQL boundary against real PGlite and PostgreSQL
 * Drizzle drivers. PGlite always runs in process; the read-only PostgreSQL
 * case runs when POSTGRES_URL is available to the real-database lane.
 */
import { PGlite } from "@electric-sql/pglite";
import { executeRawSqlOnDb, type RuntimeRawSqlDb } from "@elizaos/core/raw-sql";
import { drizzle as nodePostgresDrizzle } from "drizzle-orm/node-postgres";
import { drizzle as pgliteDrizzle } from "drizzle-orm/pglite";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

const options = { subsystem: "RawSqlDriverContract" };

describe("raw SQL real-driver result contracts", () => {
  it("extracts the direct row array returned by PGlite", async () => {
    const client = new PGlite();
    try {
      const db = pgliteDrizzle(client);
      const rows = await executeRawSqlOnDb(
        db as unknown as RuntimeRawSqlDb,
        `SELECT 7::integer AS "integerValue",
                TRUE AS "booleanValue",
                '{"owner":"pglite"}'::jsonb AS "jsonValue"`,
        options
      );

      expect(rows).toEqual([
        {
          integerValue: 7,
          booleanValue: true,
          jsonValue: { owner: "pglite" },
        },
      ]);
    } finally {
      await client.close();
    }
  });

  const postgresIt = process.env.POSTGRES_URL ? it : it.skip;

  postgresIt("extracts the wrapped rows returned by PostgreSQL", async () => {
    const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
    try {
      const db = nodePostgresDrizzle(pool);
      const rows = await executeRawSqlOnDb(
        db as unknown as RuntimeRawSqlDb,
        `SELECT 11::integer AS "integerValue",
                FALSE AS "booleanValue",
                '{"owner":"postgres"}'::jsonb AS "jsonValue"`,
        options
      );

      expect(rows).toEqual([
        {
          integerValue: 11,
          booleanValue: false,
          jsonValue: { owner: "postgres" },
        },
      ]);
    } finally {
      await pool.end();
    }
  });
});
