/**
 * GET /api/database/tables/:table/rows paged with OFFSET against a real PGlite
 * runtime: sorting by a column full of ties (or not sorting) must still show
 * every row exactly once across pages. Drives the real route over HTTP.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { createRealTestRuntime } from "../../app/test/helpers/real-runtime.ts";
import { handleDatabaseRoute } from "../src/api/database.ts";

it("returns every row exactly once when paging a sort with ties", async () => {
  const { runtime, cleanup } = await createRealTestRuntime({
    characterName: "DbViewer",
  });
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    void handleDatabaseRoute(req, res, runtime, pathname);
  });
  try {
    const db = runtime.adapter.db as {
      execute(query: unknown): Promise<unknown>;
    };
    await db.execute(
      sql.raw("CREATE TABLE paging_ties (id integer PRIMARY KEY, kind text)"),
    );
    await db.execute(
      sql.raw(
        `INSERT INTO paging_ties SELECT n, CASE WHEN n % 2 = 0 THEN 'a' ELSE 'b' END FROM generate_series(1, 120) AS n`,
      ),
    );
    // Updates move rows within the heap, so tie order is not insertion order.
    await db.execute(
      sql.raw("UPDATE paging_ties SET kind = kind WHERE id % 7 = 0"),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;

    for (const sort of ["kind", ""]) {
      const seen: number[] = [];
      for (let offset = 0; offset < 120; offset += 25) {
        const query = new URLSearchParams({
          limit: "25",
          offset: String(offset),
          ...(sort ? { sort } : {}),
        });
        const response = await fetch(
          `http://127.0.0.1:${port}/api/database/tables/paging_ties/rows?${query}`,
        );
        const body = (await response.json()) as { rows: Array<{ id: number }> };
        seen.push(...body.rows.map((row) => Number(row.id)));
      }
      expect(seen).toHaveLength(120);
      expect(new Set(seen).size).toBe(120);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  }
}, 120_000);
