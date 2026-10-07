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

it("returns every composite-key row exactly once across pages", async () => {
  const { runtime, cleanup } = await createRealTestRuntime({
    characterName: "DbViewerComposite",
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
      sql.raw(
        "CREATE TABLE paging_composite (room_id integer, id integer, kind text, PRIMARY KEY (room_id, id))",
      ),
    );
    await db.execute(
      sql.raw(
        `INSERT INTO paging_composite
         SELECT n % 4, n, CASE WHEN n % 3 = 0 THEN 'a' ELSE 'b' END
         FROM generate_series(1, 80) AS n`,
      ),
    );
    await db.execute(
      sql.raw("UPDATE paging_composite SET kind = kind WHERE id % 5 = 0"),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const seen: string[] = [];
    for (let offset = 0; offset < 80; offset += 25) {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/database/tables/paging_composite/rows?limit=25&offset=${offset}&sort=kind`,
      );
      const body = (await response.json()) as {
        rows: Array<{ room_id: number; id: number }>;
      };
      seen.push(
        ...body.rows.map((row) => `${Number(row.room_id)}:${Number(row.id)}`),
      );
    }
    expect(seen).toHaveLength(80);
    expect(new Set(seen).size).toBe(80);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  }
}, 120_000);

it("pages the visible same-named table when another schema has a different primary key", async () => {
  const { runtime, cleanup } = await createRealTestRuntime({
    characterName: "DbViewerSchema",
  });
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    void handleDatabaseRoute(req, res, runtime, pathname);
  });
  try {
    const db = runtime.adapter.db as {
      execute(query: unknown): Promise<unknown>;
    };
    await db.execute(sql.raw("CREATE SCHEMA s2"));
    await db.execute(
      sql.raw("CREATE TABLE s2.dup (uid integer PRIMARY KEY, extra text)"),
    );
    await db.execute(
      sql.raw("INSERT INTO s2.dup (uid, extra) VALUES (9, 'other')"),
    );
    await db.execute(
      sql.raw("CREATE TABLE dup (id integer PRIMARY KEY, kind text)"),
    );
    await db.execute(
      sql.raw("INSERT INTO dup (id, kind) VALUES (1, 'a'), (2, 'a')"),
    );
    // Constraint names can also collide across different tables in one schema.
    await db.execute(
      sql.raw(
        "CREATE TABLE ref_dup (other integer CONSTRAINT dup_pkey REFERENCES dup(id))",
      ),
    );
    // Both schemas are on the path. Unqualified FROM "dup" still resolves to
    // public.dup, the first visible relation. The tie-break must not pick up
    // s2.dup's uid column.
    await db.execute(sql.raw("SET search_path TO public, s2"));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/database/tables/dup/rows?limit=25&offset=0&sort=kind`,
    );
    const body = (await response.json()) as {
      rows?: Array<{ id: number }>;
      error?: string;
    };
    expect(response.status).toBe(200);
    expect(body.rows?.map((row) => Number(row.id)).sort()).toEqual([1, 2]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  }
}, 120_000);

it("searches the visible table when another schema has extra columns", async () => {
  const { runtime, cleanup } = await createRealTestRuntime({
    characterName: "DbViewerSearchSchema",
  });
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    void handleDatabaseRoute(req, res, runtime, pathname).catch(
      (error: unknown) => {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : String(error));
      },
    );
  });
  try {
    const db = runtime.adapter.db as {
      execute(query: unknown): Promise<unknown>;
    };
    await db.execute(sql.raw("CREATE SCHEMA s2"));
    await db.execute(
      sql.raw("CREATE TABLE s2.dup (uid integer PRIMARY KEY, extra text)"),
    );
    await db.execute(
      sql.raw("INSERT INTO s2.dup (uid, extra) VALUES (9, 'other-schema')"),
    );
    await db.execute(
      sql.raw("CREATE TABLE dup (id integer PRIMARY KEY, kind text)"),
    );
    await db.execute(
      sql.raw("INSERT INTO dup (id, kind) VALUES (1, 'visible')"),
    );
    await db.execute(sql.raw("SET search_path TO public, s2"));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const missed = await fetch(
      `http://127.0.0.1:${port}/api/database/tables/dup/rows?limit=25&offset=0&search=other-schema`,
    );
    const missedRaw = await missed.text();
    expect(missed.status, missedRaw).toBe(200);
    const missedBody = JSON.parse(missedRaw) as {
      rows?: Array<{ id: number }>;
    };
    expect(missedBody.rows ?? []).toEqual([]);
    const hit = await fetch(
      `http://127.0.0.1:${port}/api/database/tables/dup/rows?limit=25&offset=0&search=visible`,
    );
    const hitRaw = await hit.text();
    expect(hit.status, hitRaw).toBe(200);
    const hitBody = JSON.parse(hitRaw) as { rows?: Array<{ id: number }> };
    expect(hitBody.rows?.map((row) => Number(row.id))).toEqual([1]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  }
}, 120_000);
