import http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDatabaseRowsCompatRoute } from "./database-rows-compat-routes";

// This suite drives the REAL `ensureRouteMinRole` (via the real `./auth.ts`)
// through the route handler, mocking only the session-resolution primitives.
// The point is the P0 gate: raw table reads must require OWNER, so a USER-role
// session must be rejected with 403 before any SQL runs. The explicit
// `ensureOwner` dependency seam is also covered so local route tests can avoid
// pulling the full auth graph when they do not need it.

const mocks = vi.hoisted(() => ({
  executeRawSql: vi.fn(),
  findActiveSession: vi.fn(),
  findIdentity: vi.fn(),
  verifyCsrfToken: vi.fn(),
}));

vi.mock("@elizaos/core", () => ({
  roleRank: (role: string | undefined) =>
    (
      ({
        NONE: 0,
        GUEST: 1,
        USER: 2,
        MEMBER: 2,
        ADMIN: 3,
        OWNER: 4,
      }) as Record<string, number>
    )[role ?? "NONE"] ?? 0,
}));

vi.mock("@elizaos/shared", () => ({
  executeRawSql: mocks.executeRawSql,
  quoteIdent: (value: string) => `"${String(value).replace(/"/g, '""')}"`,
  resolveApiToken: (env: NodeJS.ProcessEnv) =>
    env.ELIZA_API_TOKEN?.trim() || null,
  sanitizeIdentifier: (value: string | null | undefined) => {
    if (value == null) return null;
    const trimmed = String(value).trim();
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed) ? trimmed : null;
  },
  sqlLiteral: (value: unknown) => `'${String(value).replace(/'/g, "''")}'`,
}));

// Avoid loading the heavy @elizaos/agent config graph through the compat route.
// For these tests, every request must resolve through the session/role path
// rather than the ambient trusted-loopback OWNER short-circuit.
vi.mock("./compat-route-shared", () => ({
  DATABASE_UNAVAILABLE_MESSAGE: "Database unavailable",
  isTrustedLocalRequest: () => false,
}));

vi.mock("./auth/sessions.js", () => ({
  CSRF_HEADER_NAME: "x-eliza-csrf",
  findActiveSession: mocks.findActiveSession,
  verifyCsrfToken: mocks.verifyCsrfToken,
}));

vi.mock("../services/auth-store.js", () => ({
  AuthStore: class MockAuthStore {
    findIdentity = mocks.findIdentity;
  },
}));

const STATE_WITHOUT_DB = {
  current: null,
} as unknown as Parameters<typeof handleDatabaseRowsCompatRoute>[2];

const STATE_WITH_DB = {
  current: { adapter: { db: {} } },
} as unknown as Parameters<typeof handleDatabaseRowsCompatRoute>[2];

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    createdAt: 0,
    csrfSecret: "csrf-secret",
    expiresAt: Date.now() + 60_000,
    id: "session-id",
    identityId: "identity-id",
    ip: null,
    kind: "browser",
    lastSeenAt: 0,
    rememberDevice: false,
    revokedAt: null,
    scopes: [],
    userAgent: null,
    ...overrides,
  };
}

function makeIdentity(kind: "owner" | "machine") {
  return {
    cloudUserId: null,
    createdAt: 0,
    displayName: kind,
    id: `${kind}-identity`,
    kind,
    passwordHash: null,
  };
}

function makeReq(
  headers: http.IncomingHttpHeaders = {},
  url = "/api/database/tables/secrets/rows?schema=public",
): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = "GET";
  req.url = url;
  req.headers = { host: "example.test:2138", ...headers };
  Object.defineProperty(req.socket, "remoteAddress", {
    configurable: true,
    value: "203.0.113.9",
  });
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

function resetMocks(): void {
  mocks.executeRawSql.mockReset();
  mocks.findActiveSession.mockReset();
  mocks.findIdentity.mockReset();
  mocks.verifyCsrfToken.mockReset();
  mocks.verifyCsrfToken.mockReturnValue(true);
}

// Canned introspection + read results so the OWNER path can complete without a
// real database.
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
  delete process.env.ELIZA_API_TOKEN;
  delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  resetMocks();
});

afterEach(() => {
  delete process.env.ELIZA_API_TOKEN;
  delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
});

describe("handleDatabaseRowsCompatRoute", () => {
  it("passes OWNER to the injected gate before raw table rows can be read", async () => {
    const req = makeReq({}, "/api/database/tables/secrets/rows");
    const res = fakeRes();
    const ensureOwner = vi.fn(async (_req, routeRes) => {
      routeRes.statusCode = 403;
      routeRes.end(JSON.stringify({ error: "Insufficient role" }));
      return false;
    });

    await expect(
      handleDatabaseRowsCompatRoute(req, res.res, STATE_WITHOUT_DB, {
        ensureOwner,
      }),
    ).resolves.toBe(true);

    expect(ensureOwner).toHaveBeenCalledWith(
      req,
      res.res,
      expect.anything(),
      "OWNER",
    );
    expect(res.status()).toBe(403);
    expect(res.json()).toEqual({ error: "Insufficient role" });
    expect(mocks.executeRawSql).not.toHaveBeenCalled();
  });

  it("continues route handling after the injected OWNER gate succeeds", async () => {
    const req = makeReq({}, "/api/database/tables/memories/rows");
    const res = fakeRes();
    const ensureOwner = vi.fn(async () => true);

    await expect(
      handleDatabaseRowsCompatRoute(req, res.res, STATE_WITHOUT_DB, {
        ensureOwner,
      }),
    ).resolves.toBe(true);

    expect(ensureOwner).toHaveBeenCalledWith(
      req,
      res.res,
      expect.anything(),
      "OWNER",
    );
    expect(res.status()).toBe(503);
    expect(res.json()).toEqual({ error: "Database unavailable" });
  });
});

describe("GET /api/database/tables/:name/rows OWNER gate", () => {
  it("rejects a USER-role machine session with 403 and never reads the table", async () => {
    // A machine identity resolves to the USER tier: an active session, but
    // not OWNER. Before the fix this reached raw SELECT * FROM <table>; now
    // it must be denied at the gate.
    mocks.findActiveSession.mockResolvedValue(
      makeSession({ id: "machine-session", kind: "machine" }),
    );
    mocks.findIdentity.mockResolvedValue(makeIdentity("machine"));

    const req = makeReq({ authorization: "Bearer machine-session" });
    const res = fakeRes();

    const handled = await handleDatabaseRowsCompatRoute(
      req,
      res.res,
      STATE_WITH_DB,
    );

    expect(handled).toBe(true);
    expect(res.status()).toBe(403);
    expect(res.json()).toEqual({ error: "Insufficient role" });
    expect(mocks.executeRawSql).not.toHaveBeenCalled();
  });

  it("allows an OWNER session to read rows", async () => {
    mocks.findActiveSession.mockResolvedValue(makeSession());
    mocks.findIdentity.mockResolvedValue(makeIdentity("owner"));
    stubReadableTable();

    const req = makeReq({ cookie: "eliza_session=owner-session" });
    const res = fakeRes();

    const handled = await handleDatabaseRowsCompatRoute(
      req,
      res.res,
      STATE_WITH_DB,
    );

    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    expect(res.json()).toMatchObject({
      columns: ["id", "value"],
      rows: [
        { id: 1, value: "a" },
        { id: 2, value: "b" },
      ],
      schema: "public",
      table: "secrets",
      total: 2,
    });
    expect(mocks.executeRawSql).toHaveBeenCalled();
  });
});
