import type http from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";

const { executeRawSql, ensureOwner } = vi.hoisted(() => ({
  executeRawSql: vi.fn(),
  ensureOwner: vi.fn(async () => true),
}));
vi.mock("@elizaos/plugin-sql", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  executeRawSql,
}));
vi.mock("./auth.ts", () => ({ ensureRouteMinRole: ensureOwner }));
vi.mock("./compat-route-shared", () => ({
  DATABASE_UNAVAILABLE_MESSAGE: "Database unavailable",
}));

import { handleDatabaseRowsCompatRoute } from "./database-rows-compat-routes";

let table = 0;
function request() {
  return {
    method: "GET",
    url: `/api/database/tables/test_${table++}/rows?schema=public`,
  } as http.IncomingMessage;
}
function response() {
  return {
    headersSent: false,
    setHeader: vi.fn(),
    end: vi.fn(),
  } as unknown as http.ServerResponse;
}
const state: CompatRuntimeState = {
  // The SQL boundary is mocked; this test needs only a present runtime.
  current: {} as NonNullable<CompatRuntimeState["current"]>,
  pendingAgentName: null,
  pendingRestartReasons: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  ensureOwner.mockResolvedValue(true);
  executeRawSql.mockReset();
  executeRawSql.mockResolvedValueOnce({ rows: [{ column_name: "id" }] });
});

describe("database row count boundary", () => {
  it("keeps table introspection within the runtime that owns the database", async () => {
    const firstRuntime = {} as NonNullable<CompatRuntimeState["current"]>;
    const secondRuntime = {} as NonNullable<CompatRuntimeState["current"]>;
    const queries: Array<{ runtime: unknown; sql: string }> = [];
    executeRawSql.mockReset();
    executeRawSql.mockImplementation(async (runtime, sql: string) => {
      queries.push({ runtime, sql });
      if (sql.includes("information_schema.columns")) {
        return {
          rows: [{ column_name: runtime === firstRuntime ? "title" : "name" }],
        };
      }
      return sql.includes("count(*)") ? { rows: [{ total: 0 }] } : { rows: [] };
    });
    const req = {
      method: "GET",
      url: "/api/database/tables/runtime_owned_items/rows?schema=public&search=query",
    } as http.IncomingMessage;
    for (const runtime of [firstRuntime, secondRuntime, secondRuntime]) {
      await handleDatabaseRowsCompatRoute(req, response(), {
        ...state,
        current: runtime,
      });
    }
    for (const runtime of [firstRuntime, secondRuntime]) {
      expect(
        queries.filter(
          (query) =>
            query.runtime === runtime &&
            query.sql.includes("information_schema.columns"),
        ),
      ).toHaveLength(1);
    }
    const secondRuntimeReads = queries.filter(
      (query) => query.runtime === secondRuntime && query.sql.includes("ILIKE"),
    );
    expect(secondRuntimeReads).toHaveLength(4);
    for (const { sql } of secondRuntimeReads) {
      expect(sql).toContain('"name"');
      expect(sql).not.toContain('"title"');
    }
  });

  it.each([
    null,
    undefined,
    "",
    " ",
    false,
    true,
    [],
    -1,
    1.5,
    "1e2",
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    "rejects malformed count %j before reading or returning rows",
    async (total) => {
      executeRawSql.mockResolvedValueOnce({ rows: [{ total }] });
      const res = response();
      await expect(
        handleDatabaseRowsCompatRoute(request(), res, state),
      ).rejects.toMatchObject({ code: "DB_COUNT_UNAVAILABLE" });
      expect(executeRawSql).toHaveBeenCalledTimes(2);
      expect(res.end).not.toHaveBeenCalled();
    },
  );

  it.each([0, "0", 42, "42"])("returns valid count %j", async (total) => {
    executeRawSql.mockResolvedValueOnce({ rows: [{ total }] });
    executeRawSql.mockResolvedValueOnce({ rows: [] });
    const res = response();
    expect(await handleDatabaseRowsCompatRoute(request(), res, state)).toBe(
      true,
    );
    expect(
      JSON.parse(vi.mocked(res.end).mock.calls[0][0] as string).total,
    ).toBe(Number(total));
  });

  it("performs no database access when owner authorization fails", async () => {
    ensureOwner.mockResolvedValue(false);
    expect(
      await handleDatabaseRowsCompatRoute(request(), response(), state),
    ).toBe(true);
    expect(executeRawSql).not.toHaveBeenCalled();
  });
});

it("pages composite primary keys and keyless rows through real SQL", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  try {
    await db.exec(
      "CREATE TABLE gallery_composite (bucket int, item int, PRIMARY KEY(bucket, item)); INSERT INTO gallery_composite SELECT 1, n FROM generate_series(1, 37) n; CREATE TABLE gallery_keyless (item int); INSERT INTO gallery_keyless SELECT n FROM generate_series(1, 37) n;",
    );
    executeRawSql.mockReset();
    executeRawSql.mockImplementation(async (_runtime, query: string) =>
      db.query(query),
    );
    for (const tableName of ["gallery_composite", "gallery_keyless"]) {
      const collected: number[] = [];
      for (let offset = 0; offset < 37; offset += 7) {
        const res = response();
        await handleDatabaseRowsCompatRoute(
          {
            method: "GET",
            url: `/api/database/tables/${tableName}/rows?schema=public&limit=7&offset=${offset}&sort=bucket`,
          } as http.IncomingMessage,
          res,
          state,
        );
        const body = JSON.parse(vi.mocked(res.end).mock.calls[0][0] as string);
        expect(body.total).toBe(37);
        collected.push(...body.rows.map((row: { item: number }) => row.item));
      }
      expect(collected).toEqual(Array.from({ length: 37 }, (_, i) => i + 1));
    }
  } finally {
    await db.close();
  }
}, 30000);
