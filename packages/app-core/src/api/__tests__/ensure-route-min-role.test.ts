/**
 * Exercises the DB-aware route role gates `ensureRouteMinRole` and
 * `ensureRouteAuthorized`: an owner browser session reaches OWNER routes, a
 * machine session is treated as USER (blocked from OWNER), CSRF rejection
 * precedes any role check on cookie writes, and the Android static-token
 * local-auth path still resolves as OWNER. Harness mocks core `roleRank`,
 * shared token resolution, the session store, `isTrustedLocalRequest`, and the
 * `AuthStore` identity lookup; requests/responses are synthetic Node http objects.
 */
import http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureRouteAuthorized, ensureRouteMinRole } from "../auth.js";

const mocks = vi.hoisted(() => {
  vi.resetModules();
  return {
    findActiveSession: vi.fn(),
    findIdentity: vi.fn(),
    verifyCsrfToken: vi.fn(),
  };
});

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
  resolveApiToken: (env: NodeJS.ProcessEnv) =>
    env.ELIZA_API_TOKEN?.trim() || null,
}));

vi.mock("../auth/sessions.js", () => ({
  CSRF_HEADER_NAME: "x-eliza-csrf",
  findActiveSession: mocks.findActiveSession,
  verifyCsrfToken: mocks.verifyCsrfToken,
}));

vi.mock("../compat-route-shared.js", () => ({
  isTrustedLocalRequest: (
    req: Pick<http.IncomingMessage, "headers" | "socket">,
  ) => {
    const host = Array.isArray(req.headers.host)
      ? req.headers.host[0]
      : req.headers.host;
    return (
      req.socket.remoteAddress === "127.0.0.1" &&
      typeof host === "string" &&
      host.startsWith("localhost")
    );
  },
}));

vi.mock("../../services/auth-store.js", () => ({
  AuthStore: class MockAuthStore {
    findIdentity = mocks.findIdentity;
  },
}));

const STATE_WITH_DB = {
  current: { adapter: { db: {} } },
};

function makeReq(options: {
  method?: string;
  headers?: http.IncomingHttpHeaders;
  remoteAddress?: string;
}): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = options.method ?? "GET";
  req.headers = {
    host: "example.test:2138",
    "x-forwarded-for": options.remoteAddress ?? "203.0.113.9",
    ...(options.headers ?? {}),
  };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: options.remoteAddress ?? "203.0.113.9",
    configurable: true,
  });
  return req;
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-id",
    identityId: "identity-id",
    kind: "browser",
    createdAt: 0,
    lastSeenAt: 0,
    expiresAt: Date.now() + 60_000,
    rememberDevice: false,
    csrfSecret: "csrf-secret",
    ip: null,
    userAgent: null,
    scopes: [],
    revokedAt: null,
    ...overrides,
  };
}

function makeIdentity(kind: "owner" | "machine") {
  return {
    id: `${kind}-identity`,
    kind,
    displayName: kind,
    createdAt: 0,
    passwordHash: null,
    cloudUserId: null,
  };
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
    res,
    status: () => res.statusCode,
    json: () => (body ? JSON.parse(body) : null),
  };
}

function clearEnv() {
  delete process.env.ELIZA_API_TOKEN;
  delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
}

describe("ensureRouteMinRole", () => {
  beforeEach(() => {
    clearEnv();
    vi.clearAllMocks();
    mocks.verifyCsrfToken.mockReturnValue(true);
  });

  afterEach(clearEnv);

  it("allows an owner browser session to reach OWNER routes", async () => {
    mocks.findActiveSession.mockResolvedValue(makeSession());
    mocks.findIdentity.mockResolvedValue(makeIdentity("owner"));
    const req = makeReq({ headers: { cookie: "eliza_session=owner-session" } });
    const res = fakeRes();

    await expect(
      ensureRouteMinRole(req, res.res, STATE_WITH_DB, "OWNER"),
    ).resolves.toBe(true);
    expect(res.status()).toBe(200);
  });

  it("rejects a machine session from OWNER routes", async () => {
    mocks.findActiveSession.mockResolvedValue(
      makeSession({ id: "machine-session", kind: "machine" }),
    );
    mocks.findIdentity.mockResolvedValue(makeIdentity("machine"));
    const req = makeReq({
      headers: { authorization: "Bearer machine-session" },
    });
    const res = fakeRes();

    await expect(
      ensureRouteMinRole(req, res.res, STATE_WITH_DB, "OWNER"),
    ).resolves.toBe(false);
    expect(res.status()).toBe(403);
    expect(res.json()).toEqual({ error: "Insufficient role" });
  });

  it("still treats a machine session as an authenticated USER tier", async () => {
    mocks.findActiveSession.mockResolvedValue(
      makeSession({ id: "machine-session", kind: "machine" }),
    );
    mocks.findIdentity.mockResolvedValue(makeIdentity("machine"));
    const req = makeReq({
      headers: { authorization: "Bearer machine-session" },
    });
    const res = fakeRes();

    await expect(
      ensureRouteMinRole(req, res.res, STATE_WITH_DB, "USER"),
    ).resolves.toBe(true);
    expect(res.status()).toBe(200);
  });

  it("uses the same resolver for plain authenticated route gates", async () => {
    mocks.findActiveSession.mockResolvedValue(
      makeSession({ id: "machine-session", kind: "machine" }),
    );
    mocks.findIdentity.mockResolvedValue(makeIdentity("machine"));
    const req = makeReq({
      headers: { authorization: "Bearer machine-session" },
    });
    const res = fakeRes();

    await expect(
      ensureRouteAuthorized(req, res.res, STATE_WITH_DB),
    ).resolves.toBe(true);
    expect(res.status()).toBe(200);
    expect(mocks.findIdentity).toHaveBeenCalledWith("identity-id");
  });

  it("preserves CSRF rejection before role checks on cookie writes", async () => {
    mocks.findActiveSession.mockResolvedValue(makeSession());
    mocks.verifyCsrfToken.mockReturnValue(false);
    const req = makeReq({
      method: "PUT",
      headers: { cookie: "eliza_session=owner-session" },
    });
    const res = fakeRes();

    await expect(
      ensureRouteMinRole(req, res.res, STATE_WITH_DB, "OWNER"),
    ).resolves.toBe(false);
    expect(res.status()).toBe(403);
    expect(res.json()).toEqual({ error: "csrf_required" });
    expect(mocks.findIdentity).not.toHaveBeenCalled();
  });

  it("preserves CSRF rejection for plain authenticated route gates", async () => {
    mocks.findActiveSession.mockResolvedValue(makeSession());
    mocks.verifyCsrfToken.mockReturnValue(false);
    const req = makeReq({
      method: "POST",
      headers: { cookie: "eliza_session=owner-session" },
    });
    const res = fakeRes();

    await expect(
      ensureRouteAuthorized(req, res.res, STATE_WITH_DB),
    ).resolves.toBe(false);
    expect(res.status()).toBe(403);
    expect(res.json()).toEqual({ error: "csrf_required" });
  });

  it("keeps Android local-auth API token compatibility as OWNER", async () => {
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    process.env.ELIZA_API_TOKEN = "owner-token";
    mocks.findActiveSession.mockResolvedValue(null);
    const req = makeReq({
      headers: { authorization: "Bearer owner-token" },
    });
    const res = fakeRes();

    await expect(
      ensureRouteMinRole(req, res.res, STATE_WITH_DB, "OWNER"),
    ).resolves.toBe(true);
    expect(res.status()).toBe(200);
  });
});
