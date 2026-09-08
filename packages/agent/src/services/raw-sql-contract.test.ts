/**
 * Exercises the approval and knowledge-graph SQL boundaries against real PGlite.
 * Faults replace only database result envelopes after the real query executes.
 */
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as approval from "./approval/sql.ts";
import * as knowledgeGraph from "./knowledge-graph/sql.ts";

for (const [name, boundary] of Object.entries({ approval, knowledgeGraph })) {
  describe(`${name} SQL consumer`, () => {
    let pg: PGlite;
    let db: ReturnType<typeof drizzle>;
    let runtime: IAgentRuntime;
    const label = "O'Reilly's account";
    const metadata = { amount: 0, enabled: false, nested: ["complete"] };

    beforeAll(async () => {
      pg = new PGlite();
      db = drizzle(pg);
      runtime = { adapter: { db } } as unknown as IAgentRuntime;
      await boundary.executeRawSql(
        runtime,
        "CREATE TABLE records (id integer PRIMARY KEY, label text, metadata jsonb)",
      );
      await boundary.executeRawSql(
        runtime,
        `INSERT INTO records VALUES (${boundary.sqlInteger(1)}, ${boundary.sqlText(label)}, ${boundary.sqlJson(metadata)})`,
      );
    });
    afterAll(async () => {
      await pg.close();
    });

    it("retains encoded values and distinguishes complete empty queries", async () => {
      const rows = await boundary.executeRawSql(
        runtime,
        "SELECT * FROM records",
      );
      expect(rows).toEqual([{ id: 1, label, metadata }]);
      expect(boundary.parseJsonRecord(rows[0]?.metadata)).toEqual(metadata);
      await expect(
        boundary.executeRawSql(runtime, "SELECT * FROM records WHERE id = 2"),
      ).resolves.toEqual([]);
    });

    it.each(
      [
        null,
        {},
        { rows: null },
        { rows: [{ id: 1 }, null] },
        [{ id: 1 }, false],
        new Array(2),
      ].map((invalid) => ({ invalid })),
    )(
      "rejects malformed result %# after executing the query",
      async ({ invalid }) => {
        const broken = {
          adapter: {
            db: {
              execute: async (query: Parameters<typeof db.execute>[0]) => {
                await db.execute(query);
                return invalid;
              },
            },
          },
        } as unknown as IAgentRuntime;
        await expect(
          boundary.executeRawSql(broken, "SELECT * FROM records"),
        ).rejects.toMatchObject({ code: "SQL_RESULT_INVALID" });
        expect((await pg.query("SELECT * FROM records")).rows).toEqual([
          { id: 1, label, metadata },
        ]);
      },
    );

    it("rejects invalid persisted JSON with its parse cause", async () => {
      const rows = await boundary.executeRawSql(
        runtime,
        "SELECT 'not-json' AS payload",
      );
      expect(() => boundary.parseJsonRecord(rows[0]?.payload)).toThrow(
        expect.objectContaining({
          code: "SQL_JSON_INVALID",
          cause: expect.any(SyntaxError),
        }),
      );
    });
  });
}

it("keeps approval writes on the caller's transaction and rolls them back on failure", async () => {
  const pg = new PGlite();
  try {
    const db = drizzle(pg);
    await pg.exec("CREATE TABLE approvals (id integer PRIMARY KEY)");
    await expect(
      db.transaction(async (tx) => {
        await approval.executeRawSqlTx(tx, "INSERT INTO approvals VALUES (1)");
        await approval.executeRawSqlTx(tx, "INSERT INTO approvals VALUES (1)");
      }),
    ).rejects.toThrow();
    expect((await pg.query("SELECT * FROM approvals")).rows).toEqual([]);
  } finally {
    await pg.close();
  }
});
