/**
 * DATABASE get_table pages with OFFSET against a real runtime. A sort column
 * full of ties must still return every row once when a write lands between pages.
 */
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { createRealTestRuntime } from "../../app/test/helpers/real-runtime.ts";
import { databaseAction } from "../src/actions/database.ts";

it("returns every tied row once when get_table pages around a write", async () => {
  const { runtime, cleanup } = await createRealTestRuntime({
    characterName: "DbActionPaging",
  });
  try {
    const db = runtime.adapter.db as {
      execute(query: unknown): Promise<unknown>;
    };
    await db.execute(
      sql.raw(
        "CREATE TABLE action_paging_ties (room_id integer, id integer, kind integer, PRIMARY KEY (room_id, id))",
      ),
    );
    await db.execute(
      sql.raw(
        "INSERT INTO action_paging_ties SELECT 1, n, 1 FROM generate_series(1, 40) AS n",
      ),
    );
    const handler = databaseAction.handler;
    if (!handler) throw new Error("DATABASE handler is missing");

    async function page(offset: number, sortBy?: string): Promise<number[]> {
      const result = await handler(
        runtime,
        {} as never,
        undefined,
        {
          parameters: {
            action: "get_table",
            tableName: "action_paging_ties",
            limit: 8,
            offset,
            ...(sortBy ? { sortBy, sortDir: "asc" } : {}),
          },
        },
        undefined,
      );
      expect(result.success).toBe(true);
      const rows = (
        result.data as { rows?: Array<{ id: number | string }> } | undefined
      )?.rows;
      return (rows ?? []).map((row) => Number(row.id));
    }

    for (const sortBy of ["kind", undefined] as const) {
      const seen: number[] = [];
      for (let offset = 0; offset < 40; offset += 8) {
        if (offset === 8) {
          await db.execute(
            sql.raw(
              "UPDATE action_paging_ties SET kind = kind WHERE id IN (1,2,3,4,5)",
            ),
          );
        }
        seen.push(...(await page(offset, sortBy)));
      }
      expect(seen).toHaveLength(40);
      expect(new Set(seen).size).toBe(40);
    }
  } finally {
    await cleanup();
  }
}, 120_000);
