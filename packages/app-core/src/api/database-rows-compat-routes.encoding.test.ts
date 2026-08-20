/** Exercises table-name decoding after OWNER authorization without a real database. */
import http from "node:http";
import { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeRawSql: vi.fn(),
}));

vi.mock("@elizaos/core", () => ({
  ElizaError: class ElizaError extends Error {
    readonly code: string;
    readonly context?: Record<string, unknown>;
    readonly severity?: string;

    constructor(
      message: string,
      options: {
        code: string;
        context?: Record<string, unknown>;
        severity?: string;
      },
    ) {
      super(message);
      this.name = "ElizaError";
      this.code = options.code;
      this.context = options.context;
      this.severity = options.severity;
    }
  },
  logger: { warn() {}, debug() {}, info() {}, error() {} },
}));

vi.mock("@elizaos/shared", () => ({
  executeRawSql: mocks.executeRawSql,
  quoteIdent: (value: string) => `"${String(value).replace(/"/g, '""')}"`,
  sanitizeIdentifier: (value: string | null | undefined) => {
    if (value == null) return null;
    const trimmed = String(value).trim();
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed) ? trimmed : null;
  },
  sqlLiteral: (value: unknown) => `'${String(value).replace(/'/g, "''")}'`,
}));

vi.mock("./auth.ts", () => ({
  ensureRouteMinRole: vi.fn(async () => true),
}));

vi.mock("./compat-route-shared", () => ({
  DATABASE_UNAVAILABLE_MESSAGE: "Database unavailable",
  isTrustedLocalRequest: () => false,
}));

const { handleDatabaseRowsCompatRoute } = await import(
  "./database-rows-compat-routes"
);

const STATE_WITH_DB = {
  current: { adapter: { db: {} } },
} as unknown as Parameters<typeof handleDatabaseRowsCompatRoute>[2];

function makeReq(url: string): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = "GET";
  req.url = url;
  req.headers = { host: "example.test:2138" };
  return req;
}

function fakeRes() {
  let body = "";
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") body += chunk;
    else if (chunk) body += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return {
    json: () => (body ? JSON.parse(body) : null),
    res,
    status: () => res.statusCode,
  };
}

function stubReadableTable() {
  mocks.executeRawSql.mockImplementation(async (_runtime, sql: string) => {
    if (sql.includes("information_schema.columns")) {
      return { rows: [{ column_name: "id" }, { column_name: "value" }] };
    }
    if (sql.includes("count(*)")) {
      return { rows: [{ total: 2 }] };
    }
    return {
      rows: [
        { id: 1, value: "a" },
        { id: 2, value: "b" },
      ],
    };
  });
}

beforeEach(() => {
  mocks.executeRawSql.mockReset();
});

describe("GET /api/database/tables/:name/rows encoding", () => {
  it("non-rows table path is untouched", async () => {
    const res = fakeRes();
    const ensureOwner = vi.fn(async () => true);
    const handled = await handleDatabaseRowsCompatRoute(
      makeReq("/api/database/tables/secrets"),
      res.res,
      STATE_WITH_DB,
      { ensureOwner },
    );
    expect(handled).toBe(false);
    expect(ensureOwner).not.toHaveBeenCalled();
    expect(mocks.executeRawSql).not.toHaveBeenCalled();
  });

  it("canonical percent-encoded table name still reaches SQL", async () => {
    stubReadableTable();
    const res = fakeRes();
    const ensureOwner = vi.fn(async () => true);
    const handled = await handleDatabaseRowsCompatRoute(
      makeReq("/api/database/tables/secret%73/rows?schema=public"),
      res.res,
      STATE_WITH_DB,
      { ensureOwner },
    );
    expect(handled).toBe(true);
    expect(ensureOwner).toHaveBeenCalled();
    expect(mocks.executeRawSql).toHaveBeenCalled();
    const sql = mocks.executeRawSql.mock.calls
      .map((call) => String(call[1]))
      .join("\n");
    expect(sql).toContain('"secrets"');
    expect(res.status()).toBe(200);
    expect(res.json()).toMatchObject({ table: "secrets", schema: "public" });
  });

  it.each([
    "/api/database/tables/%/rows",
    "/api/database/tables/%2/rows",
    "/api/database/tables/%ZZ/rows",
    "/api/database/tables/%E0%A4/rows",
  ])(
    "rejects malformed %s with 400 after owner auth and before SQL",
    async (url) => {
      const res = fakeRes();
      const ensureOwner = vi.fn(async () => true);
      const handled = await handleDatabaseRowsCompatRoute(
        makeReq(url),
        res.res,
        STATE_WITH_DB,
        { ensureOwner },
      );
      expect(handled).toBe(true);
      expect(res.status()).toBe(400);
      expect(res.json()).toEqual({
        error: "invalid table name: malformed URL encoding",
      });
      expect(ensureOwner).toHaveBeenCalledWith(
        expect.anything(),
        res.res,
        STATE_WITH_DB,
        "OWNER",
      );
      expect(mocks.executeRawSql).not.toHaveBeenCalled();
    },
  );

  it("preserves OWNER denial before reporting malformed encoding", async () => {
    const res = fakeRes();
    const ensureOwner = vi.fn(async () => {
      res.res.statusCode = 403;
      res.res.end(JSON.stringify({ error: "forbidden" }));
      return false;
    });
    const handled = await handleDatabaseRowsCompatRoute(
      makeReq("/api/database/tables/%ZZ/rows"),
      res.res,
      STATE_WITH_DB,
      { ensureOwner },
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden" });
    expect(mocks.executeRawSql).not.toHaveBeenCalled();
  });
});
