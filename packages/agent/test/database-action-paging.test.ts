/**
 * DATABASE get_table pages with OFFSET against a real runtime. A sort column
 * full of ties must still return every row once when a write lands between
 * pages, and a same-named table in another schema must not change the order.
 */
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { createRealTestRuntime } from "../../app/test/helpers/real-runtime.ts";
import { databaseAction } from "../src/actions/database.ts";

it("returns every tied row once and ignores another schema's primary key", async () => {
  const { runtime, cleanup } = await createRealTestRuntime({
    characterName: "DbActionPaging",
  });
  try {
    const db = runtime.adapter.db as {
      execute(query: unknown): Promise<unknown>;
    };
    await db.execute(sql.raw("CREATE SCHEMA plugin_x"));
    await db.execute(
      sql.raw(
        "CREATE TABLE plugin_x.action_paging_ties (item_key integer PRIMARY KEY, kind integer)",
      ),
    );
    await db.execute(
      sql.raw("INSERT INTO plugin_x.action_paging_ties VALUES (1, 1)"),
    );
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

    async function page(
      offset: number,
      sortBy?: string,
      tableName = "action_paging_ties",
    ): Promise<number[]> {
      const result = await handler(
        runtime,
        {} as never,
        undefined,
        {
          parameters: {
            action: "get_table",
            tableName,
            limit: 8,
            offset,
            ...(sortBy ? { sortBy, sortDir: "asc" } : {}),
          },
        },
        undefined,
      );
      expect(result.success, result.text).toBe(true);
      const rows = (
        result.data as { rows?: Array<{ id: number | string }> } | undefined
      )?.rows;
      return (rows ?? []).map((row) => Number(row.id));
    }

    for (const sortBy of ["kind", "item_key", undefined] as const) {
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

    await db.execute(
      sql.raw("CREATE TABLE action_paging_nokey (id integer, kind integer)"),
    );
    await db.execute(
      sql.raw(
        "INSERT INTO action_paging_nokey SELECT n, 1 FROM generate_series(1, 16) AS n",
      ),
    );
    const keyless = [
      ...(await page(0, "kind", "action_paging_nokey")),
      ...(await page(8, "kind", "action_paging_nokey")),
    ];
    expect(keyless).toHaveLength(16);
    expect(new Set(keyless).size).toBe(16);

    await db.execute(sql.raw("CREATE SCHEMA hidden_ns"));
    await db.execute(
      sql.raw("CREATE TABLE hidden_ns.only_here (id integer PRIMARY KEY)"),
    );
    const hidden = await handler(
      runtime,
      {} as never,
      undefined,
      {
        parameters: {
          action: "get_table",
          tableName: "only_here",
          limit: 8,
          offset: 0,
        },
      },
      undefined,
    );
    expect(hidden.success).toBe(false);
    expect(hidden.text).toBe('Table "only_here" not found.');
    const systemTable = await handler(
      runtime,
      {} as never,
      undefined,
      { parameters: { action: "get_table", tableName: "pg_class" } },
      undefined,
    );
    expect(systemTable.success).toBe(false);
    expect(systemTable.text).toBe('Table "pg_class" not found.');
  } finally {
    await cleanup();
  }
}, 120_000);
