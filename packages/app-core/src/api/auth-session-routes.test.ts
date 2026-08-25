/**
 * Unit tests for `handleAuthSessionRoutes` and its exported limiter reset /
 * session-cookie name. Drives the real route module with synthetic Node
 * `http` request/response objects and an in-memory `AuthStore` so dispatch,
 * db-unavailable, rate-limit overflow, setup/login/logout/me, password
 * change, session listing, and revoke branches run as written.
 */
import fs from "node:fs";
import * as http from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppendAuditEventInput,
  AuthIdentityRow,
  AuthSessionRow,
  CreateIdentityInput,
  CreateSessionInput,
} from "../services/auth-store";
import { hashPassword } from "./auth/index";
import { _resetSensitiveLimiters } from "./auth/sensitive-rate-limit";
import {
  _resetAuthSessionRoutesLimiter,
  handleAuthSessionRoutes,
  SESSION_COOKIE_NAME,
} from "./auth-session-routes";
import type { CompatRuntimeState } from "./compat-route-shared";

const STRONG_PASSWORD = "correct-horse battery 9!";

type MemoryIdentity = AuthIdentityRow;
type MemorySession = AuthSessionRow;

const memory = vi.hoisted(() => {
  const identities = new Map<string, MemoryIdentity>();
  const sessions = new Map<string, MemorySession>();
  const audits: AppendAuditEventInput[] = [];
  return {
    identities,
    sessions,
    audits,
    reset(): void {
      identities.clear();
      sessions.clear();
      audits.length = 0;
    },
  };
});

vi.mock("../services/auth-store", () => {
  class MemoryAuthStore {
    async createIdentity(input: CreateIdentityInput): Promise<MemoryIdentity> {
      const row: MemoryIdentity = {
        id: input.id,
        kind: input.kind,
        displayName: input.displayName,
        createdAt: input.createdAt,
        passwordHash: input.passwordHash ?? null,
        cloudUserId: input.cloudUserId ?? null,
      };
      memory.identities.set(row.id, row);
      return { ...row };
    }

    async findIdentity(id: string): Promise<MemoryIdentity | null> {
      const row = memory.identities.get(id);
      return row ? { ...row } : null;
    }

    async findIdentityByDisplayName(
      displayName: string,
    ): Promise<MemoryIdentity | null> {
      for (const row of memory.identities.values()) {
        if (row.displayName === displayName) return { ...row };
      }
      return null;
    }

    async updateIdentityPassword(
      id: string,
      passwordHash: string,
    ): Promise<void> {
      const row = memory.identities.get(id);
      if (!row) return;
      row.passwordHash = passwordHash;
    }

    async listIdentitiesByKind(
      kind: "owner" | "machine",
    ): Promise<MemoryIdentity[]> {
      return [...memory.identities.values()]
        .filter((row) => row.kind === kind)
        .map((row) => ({ ...row }));
    }

    async hasOwnerIdentity(): Promise<boolean> {
      for (const row of memory.identities.values()) {
        if (row.kind === "owner") return true;
      }
      return false;
    }

    async createSession(input: CreateSessionInput): Promise<MemorySession> {
      const row: MemorySession = {
        id: input.id,
        identityId: input.identityId,
        kind: input.kind,
        createdAt: input.createdAt,
        lastSeenAt: input.lastSeenAt,
        expiresAt: input.expiresAt,
        rememberDevice: input.rememberDevice,
        csrfSecret: input.csrfSecret,
        ip: input.ip,
        userAgent: input.userAgent,
        scopes: [...input.scopes],
        revokedAt: null,
      };
      memory.sessions.set(row.id, row);
      return { ...row, scopes: [...row.scopes] };
    }

    async findSession(
      id: string,
      now: number = Date.now(),
    ): Promise<MemorySession | null> {
      const row = memory.sessions.get(id);
      if (!row) return null;
      if (row.revokedAt !== null) return null;
      if (row.expiresAt <= now) return null;
      return { ...row, scopes: [...row.scopes] };
    }

    async revokeSession(
      id: string,
      now: number = Date.now(),
    ): Promise<boolean> {
      const row = memory.sessions.get(id);
      if (!row || row.revokedAt !== null) return false;
      row.revokedAt = now;
      return true;
    }

    async touchSession(
      id: string,
      lastSeenAt: number,
      expiresAt: number,
    ): Promise<void> {
      const row = memory.sessions.get(id);
      if (!row || row.revokedAt !== null) return;
      row.lastSeenAt = lastSeenAt;
      row.expiresAt = expiresAt;
    }

    async listSessionsForIdentity(
      identityId: string,
      now: number = Date.now(),
    ): Promise<MemorySession[]> {
      return [...memory.sessions.values()]
        .filter(
          (row) =>
            row.identityId === identityId &&
            row.revokedAt === null &&
            row.expiresAt > now,
        )
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .map((row) => ({ ...row, scopes: [...row.scopes] }));
    }

    async appendAuditEvent(
      input: AppendAuditEventInput,
    ): Promise<AppendAuditEventInput> {
      memory.audits.push(input);
      return input;
    }
  }

  return { AuthStore: MemoryAuthStore };
});

const STATE_NO_DB: CompatRuntimeState = {
  current: null,
  pendingAgentName: null,
  pendingRestartReasons: [],
};

const STATE_WITH_DB: CompatRuntimeState = {
  current: {
    adapter: { db: {} },
  } as CompatRuntimeState["current"],
  pendingAgentName: null,
  pendingRestartReasons: [],
};

const DB_UNAVAILABLE_PATHS = [
  "/api/auth/setup",
  "/api/auth/login/password",
  "/api/auth/password/change",
  "/api/auth/logout",
  "/api/auth/me",
  "/api/auth/sessions",
  "/api/auth/sessions/abc/revoke",
] as const;

interface FakeRes {
  res: http.ServerResponse;
  body(): unknown;
  status(): number;
  cookies(): string[];
}

function fakeRes(): FakeRes {
  let bodyText = "";
  const cookies: string[] = [];
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
  res.setHeader = (name: string, value: number | string | string[]) => {
    if (name.toLowerCase() === "set-cookie") {
      if (Array.isArray(value)) cookies.push(...value.map(String));
      else cookies.push(String(value));
    }
    return res;
  };
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") bodyText += chunk;
    else if (chunk) bodyText += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return {
    res,
    body() {
      return bodyText.length > 0 ? JSON.parse(bodyText) : null;
    },
    status() {
      return res.statusCode;
    },
    cookies() {
      return cookies;
    },
  };
}

function fakeReq(opts: {
  method?: string;
  pathname?: string;
  body?: unknown;
  cookie?: string;
  bearer?: string;
  ip?: string | null;
  headers?: http.IncomingHttpHeaders;
}): http.IncomingMessage {
  const bodyStr = opts.body === undefined ? "" : JSON.stringify(opts.body);
  const req = new http.IncomingMessage(new Socket());
  const headers: http.IncomingHttpHeaders = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.method !== undefined) req.method = opts.method;
  if (opts.pathname !== undefined) req.url = opts.pathname;
  req.headers = headers;
  req.push(bodyStr);
  req.push(null);
  Object.defineProperty(req.socket, "remoteAddress", {
    value: opts.ip === undefined ? "203.0.113.10" : opts.ip,
    configurable: true,
  });
  return req;
}

function localReq(opts: {
  method?: string;
  pathname: string;
  body?: unknown;
}): http.IncomingMessage {
  return fakeReq({
    ...opts,
    ip: "127.0.0.1",
    headers: { host: "localhost:31337" },
  });
}

function requireOwner(id = "owner-1"): MemoryIdentity {
  const owner = memory.identities.get(id);
  if (!owner) throw new Error(`expected seeded owner ${id}`);
  return owner;
}

async function seedOwner(opts?: {
  displayName?: string;
  password?: string | null;
  id?: string;
}): Promise<MemoryIdentity> {
  const passwordHash =
    opts?.password === null
      ? null
      : await hashPassword(opts?.password ?? STRONG_PASSWORD);
  const row: MemoryIdentity = {
    id: opts?.id ?? "owner-1",
    kind: "owner",
    displayName: opts?.displayName ?? "alice",
    createdAt: Date.now(),
    passwordHash,
    cloudUserId: null,
  };
  memory.identities.set(row.id, row);
  return row;
}

function seedSession(opts: {
  id: string;
  identityId: string;
  kind?: "browser" | "machine";
  expiresAt?: number;
  revokedAt?: number | null;
  lastSeenAt?: number;
}): MemorySession {
  const now = Date.now();
  const row: MemorySession = {
    id: opts.id,
    identityId: opts.identityId,
    kind: opts.kind ?? "browser",
    createdAt: now,
    lastSeenAt: opts.lastSeenAt ?? now,
    expiresAt: opts.expiresAt ?? now + 60_000,
    rememberDevice: false,
    csrfSecret: "csrf-secret",
    ip: "203.0.113.10",
    userAgent: "vitest",
    scopes: [],
    revokedAt: opts.revokedAt ?? null,
  };
  memory.sessions.set(row.id, row);
  return row;
}

describe("auth session routes", () => {
  let stateDir: string;
  const previousStateDir = process.env.ELIZA_STATE_DIR;

  beforeEach(() => {
    memory.reset();
    _resetAuthSessionRoutesLimiter();
    _resetSensitiveLimiters();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-auth-session-"));
    process.env.ELIZA_STATE_DIR = stateDir;
    delete process.env.ELIZA_API_TOKEN;
    delete process.env.ELIZA_CLOUD_PROVISIONED;
    delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
    delete process.env.ELIZA_DEV_AUTH_BYPASS;
  });

  afterEach(() => {
    _resetAuthSessionRoutesLimiter();
    _resetSensitiveLimiters();
    fs.rmSync(stateDir, { recursive: true, force: true });
    if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = previousStateDir;
    delete process.env.ELIZA_API_TOKEN;
    delete process.env.ELIZA_CLOUD_PROVISIONED;
    delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
    delete process.env.ELIZA_DEV_AUTH_BYPASS;
  });

  it("re-exports the session cookie name used by bootstrap-routes", () => {
    expect(SESSION_COOKIE_NAME).toBe("eliza_session");
  });

  it("falls through for non-auth paths, missing urls, and method mismatches", async () => {
    const unrelated = fakeRes();
    await expect(
      handleAuthSessionRoutes(
        fakeReq({ method: "GET", pathname: "/api/health" }),
        unrelated.res,
        STATE_WITH_DB,
      ),
    ).resolves.toBe(false);

    const missing = fakeRes();
    await expect(
      handleAuthSessionRoutes(fakeReq({}), missing.res, STATE_WITH_DB),
    ).resolves.toBe(false);

    const wrongMethod = fakeRes();
    await expect(
      handleAuthSessionRoutes(
        fakeReq({ method: "GET", pathname: "/api/auth/setup" }),
        wrongMethod.res,
        STATE_WITH_DB,
      ),
    ).resolves.toBe(false);

    const extraRevokePath = fakeRes();
    await expect(
      handleAuthSessionRoutes(
        fakeReq({
          method: "POST",
          pathname: "/api/auth/sessions/abc/revoke/extra",
        }),
        extraRevokePath.res,
        STATE_WITH_DB,
      ),
    ).resolves.toBe(false);
  });

  it("serves local /api/auth/me without a db and 503s every other session path", async () => {
    const localMe = fakeRes();
    await expect(
      handleAuthSessionRoutes(
        localReq({ method: "GET", pathname: "/api/auth/me" }),
        localMe.res,
        STATE_NO_DB,
      ),
    ).resolves.toBe(true);
    expect(localMe.status()).toBe(200);
    expect(localMe.body()).toEqual({
      identity: {
        id: "local-loopback",
        displayName: "Local",
        kind: "owner",
      },
      session: {
        id: "local-loopback",
        kind: "local",
        expiresAt: null,
      },
      access: {
        mode: "local",
        passwordConfigured: false,
        ownerConfigured: false,
        role: "OWNER",
      },
    });

    const remoteMe = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({ method: "GET", pathname: "/api/auth/me" }),
      remoteMe.res,
      STATE_NO_DB,
    );
    expect(remoteMe.status()).toBe(503);
    expect(remoteMe.body()).toEqual({
      error: "db_unavailable",
      reason: "db_unavailable",
    });

    for (const pathname of DB_UNAVAILABLE_PATHS) {
      if (pathname === "/api/auth/me") continue;
      const res = fakeRes();
      const handled = await handleAuthSessionRoutes(
        fakeReq({
          method: pathname === "/api/auth/sessions" ? "GET" : "POST",
          pathname,
        }),
        res.res,
        STATE_NO_DB,
      );
      expect(handled, pathname).toBe(true);
      expect(res.status(), pathname).toBe(503);
    }

    const unknown = fakeRes();
    await expect(
      handleAuthSessionRoutes(
        fakeReq({ method: "GET", pathname: "/api/auth/not-a-session-route" }),
        unknown.res,
        STATE_NO_DB,
      ),
    ).resolves.toBe(false);

    const noAdapterDb: CompatRuntimeState = {
      current: { adapter: {} } as CompatRuntimeState["current"],
      pendingAgentName: null,
      pendingRestartReasons: [],
    };
    const missingAdapterDb = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({ method: "POST", pathname: "/api/auth/logout" }),
      missingAdapterDb.res,
      noAdapterDb,
    );
    expect(missingAdapterDb.status()).toBe(503);
  });

  it("rate-limits setup at 20 attempts per IP and resets independently per bucket", async () => {
    await seedOwner();

    for (let i = 0; i < 20; i += 1) {
      const res = fakeRes();
      await handleAuthSessionRoutes(
        fakeReq({
          method: "POST",
          pathname: "/api/auth/setup",
          ip: "198.51.100.7",
          body: { displayName: "bob", password: STRONG_PASSWORD },
        }),
        res.res,
        STATE_WITH_DB,
      );
      expect(res.status()).toBe(409);
    }

    const overflow = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/setup",
        ip: "198.51.100.7",
        body: { displayName: "bob", password: STRONG_PASSWORD },
      }),
      overflow.res,
      STATE_WITH_DB,
    );
    expect(overflow.status()).toBe(429);
    expect(overflow.body()).toEqual({ error: "Too many requests" });

    const otherIp = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/setup",
        ip: "198.51.100.8",
        body: { displayName: "bob", password: STRONG_PASSWORD },
      }),
      otherIp.res,
      STATE_WITH_DB,
    );
    expect(otherIp.status()).toBe(409);

    _resetAuthSessionRoutesLimiter();
    const afterReset = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/setup",
        ip: "198.51.100.7",
        body: { displayName: "bob", password: STRONG_PASSWORD },
      }),
      afterReset.res,
      STATE_WITH_DB,
    );
    expect(afterReset.status()).toBe(409);
  });

  it("rejects invalid setup display names and weak passwords before creating an owner", async () => {
    const invalidName = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/setup",
        body: { displayName: "bad name!", password: STRONG_PASSWORD },
      }),
      invalidName.res,
      STATE_WITH_DB,
    );
    expect(invalidName.status()).toBe(400);
    expect(invalidName.body()).toEqual({ error: "invalid_display_name" });

    const tooLong = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/setup",
        body: { displayName: "a".repeat(65), password: STRONG_PASSWORD },
      }),
      tooLong.res,
      STATE_WITH_DB,
    );
    expect(tooLong.status()).toBe(400);

    const emptyName = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/setup",
        body: { displayName: "   ", password: STRONG_PASSWORD },
      }),
      emptyName.res,
      STATE_WITH_DB,
    );
    expect(emptyName.status()).toBe(400);

    const weak = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/setup",
        body: { displayName: "alice", password: "short" },
      }),
      weak.res,
      STATE_WITH_DB,
    );
    expect(weak.status()).toBe(400);
    expect(weak.body()).toEqual({
      error: "weak_password",
      reason: "too_short",
    });

    const noLetter = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/setup",
        body: { displayName: "alice", password: "1234567890!!" },
      }),
      noLetter.res,
      STATE_WITH_DB,
    );
    expect(noLetter.status()).toBe(400);
    expect((noLetter.body() as { reason: string }).reason).toBe(
      "missing_letter",
    );

    const noDigit = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/setup",
        body: { displayName: "alice", password: "abcdefghijkl" },
      }),
      noDigit.res,
      STATE_WITH_DB,
    );
    expect(noDigit.status()).toBe(400);
    expect((noDigit.body() as { reason: string }).reason).toBe(
      "missing_digit_or_symbol",
    );

    expect(memory.identities.size).toBe(0);
  });

  it("creates the owner on first setup and mints session cookies", async () => {
    const res = fakeRes();
    const handled = await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/setup",
        body: { displayName: "  alice  ", password: STRONG_PASSWORD },
        headers: { "user-agent": "vitest-setup" },
      }),
      res.res,
      STATE_WITH_DB,
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    const body = res.body() as {
      identity: { id: string; displayName: string; kind: string };
      session: { id: string; kind: string; expiresAt: number };
      csrfToken: string;
    };
    expect(body.identity.displayName).toBe("alice");
    expect(body.identity.kind).toBe("owner");
    expect(body.session.id).toMatch(/^[a-f0-9]{64}$/);
    expect(body.csrfToken).toMatch(/^[a-f0-9]{64}$/);
    expect(
      res.cookies().some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`)),
    ).toBe(true);
    expect(memory.identities.size).toBe(1);
    expect(
      memory.audits.some(
        (event) => event.action === "auth.setup" && event.outcome === "success",
      ),
    ).toBe(true);

    const second = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/setup",
        body: { displayName: "bob", password: STRONG_PASSWORD },
      }),
      second.res,
      STATE_WITH_DB,
    );
    expect(second.status()).toBe(409);
    expect(second.body()).toEqual({
      error: "already_initialized",
      reason: "already_initialized",
    });
  });

  it("rejects login on invalid input, unknown identity, missing hash, and bad password", async () => {
    const invalid = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/login/password",
        body: { displayName: "alice", password: "" },
      }),
      invalid.res,
      STATE_WITH_DB,
    );
    expect(invalid.status()).toBe(400);
    expect(invalid.body()).toEqual({ error: "invalid_credentials" });

    const unknown = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/login/password",
        body: { displayName: "alice", password: STRONG_PASSWORD },
      }),
      unknown.res,
      STATE_WITH_DB,
    );
    expect(unknown.status()).toBe(401);

    await seedOwner({ password: null });
    const noHash = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/login/password",
        body: { displayName: "alice", password: STRONG_PASSWORD },
      }),
      noHash.res,
      STATE_WITH_DB,
    );
    expect(noHash.status()).toBe(401);

    memory.reset();
    await seedOwner({ password: STRONG_PASSWORD });
    const bad = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/login/password",
        body: { displayName: "alice", password: "wrong-password-1" },
      }),
      bad.res,
      STATE_WITH_DB,
    );
    expect(bad.status()).toBe(401);

    const owner = memory.identities.get("owner-1");
    if (!owner) throw new Error("expected seeded owner");
    owner.passwordHash = "not-a-valid-argon2-hash";
    const malformed = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/login/password",
        body: { displayName: "alice", password: STRONG_PASSWORD },
      }),
      malformed.res,
      STATE_WITH_DB,
    );
    expect(malformed.status()).toBe(401);
  });

  it("logs in with a good password and honours rememberDevice === true only", async () => {
    await seedOwner();
    const good = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/login/password",
        body: {
          displayName: " alice ",
          password: STRONG_PASSWORD,
          rememberDevice: true,
        },
      }),
      good.res,
      STATE_WITH_DB,
    );
    expect(good.status()).toBe(200);
    const body = good.body() as {
      identity: { displayName: string; kind: string };
      session: { id: string };
      csrfToken: string;
    };
    expect(body.identity.displayName).toBe("alice");
    expect(body.session.id).toMatch(/^[a-f0-9]{64}$/);
    const session = memory.sessions.get(body.session.id);
    expect(session?.rememberDevice).toBe(true);
    expect(good.cookies().length).toBeGreaterThan(0);
  });

  it("logout always returns ok and revokes an active session when present", async () => {
    const noCookie = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({ method: "POST", pathname: "/api/auth/logout" }),
      noCookie.res,
      STATE_WITH_DB,
    );
    expect(noCookie.status()).toBe(200);
    expect(noCookie.body()).toEqual({ ok: true });
    expect(noCookie.cookies().some((c) => c.includes("Max-Age=0"))).toBe(true);

    const missing = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/logout",
        cookie: `${SESSION_COOKIE_NAME}=missing-session`,
      }),
      missing.res,
      STATE_WITH_DB,
    );
    expect(missing.status()).toBe(200);

    await seedOwner();
    seedSession({ id: "sess-live", identityId: "owner-1" });
    const live = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/logout",
        cookie: `${SESSION_COOKIE_NAME}=sess-live`,
      }),
      live.res,
      STATE_WITH_DB,
    );
    expect(live.status()).toBe(200);
    expect(memory.sessions.get("sess-live")?.revokedAt).not.toBeNull();
  });

  it("GET /api/auth/me covers local owner presence and remote session/guest reasons", async () => {
    const localEmpty = fakeRes();
    await handleAuthSessionRoutes(
      localReq({ method: "GET", pathname: "/api/auth/me" }),
      localEmpty.res,
      STATE_WITH_DB,
    );
    expect(localEmpty.status()).toBe(200);
    expect(
      (localEmpty.body() as { access: { ownerConfigured: boolean } }).access
        .ownerConfigured,
    ).toBe(false);

    await seedOwner();
    const localOwner = fakeRes();
    await handleAuthSessionRoutes(
      localReq({ method: "GET", pathname: "/api/auth/me" }),
      localOwner.res,
      STATE_WITH_DB,
    );
    const localBody = localOwner.body() as {
      identity: { id: string; displayName: string };
      access: { passwordConfigured: boolean; ownerConfigured: boolean };
    };
    expect(localBody.identity.id).toBe("owner-1");
    expect(localBody.access.passwordConfigured).toBe(true);
    expect(localBody.access.ownerConfigured).toBe(true);

    const remoteNoPassword = fakeRes();
    requireOwner().passwordHash = null;
    await handleAuthSessionRoutes(
      fakeReq({ method: "GET", pathname: "/api/auth/me" }),
      remoteNoPassword.res,
      STATE_WITH_DB,
    );
    expect(remoteNoPassword.status()).toBe(401);
    expect((remoteNoPassword.body() as { reason: string }).reason).toBe(
      "remote_password_not_configured",
    );

    requireOwner().passwordHash = "hashed";
    const remoteAuthRequired = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({ method: "GET", pathname: "/api/auth/me" }),
      remoteAuthRequired.res,
      STATE_WITH_DB,
    );
    expect(remoteAuthRequired.status()).toBe(401);
    expect((remoteAuthRequired.body() as { reason: string }).reason).toBe(
      "remote_auth_required",
    );

    seedSession({ id: "sess-me", identityId: "owner-1" });
    const authed = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "GET",
        pathname: "/api/auth/me",
        cookie: `${SESSION_COOKIE_NAME}=sess-me`,
      }),
      authed.res,
      STATE_WITH_DB,
    );
    expect(authed.status()).toBe(200);
    const authedBody = authed.body() as {
      session: { id: string };
      access: { mode: string; role: string };
    };
    expect(authedBody.session.id).toBe("sess-me");
    expect(authedBody.access.mode).toBe("session");
    expect(authedBody.access.role).toBe("OWNER");
  });

  it("password change uses the sensitive bucket, rejects weak/new-missing identity, and updates the hash", async () => {
    const weak = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/password/change",
        body: { newPassword: "short" },
      }),
      weak.res,
      STATE_WITH_DB,
    );
    expect(weak.status()).toBe(400);
    expect((weak.body() as { reason: string }).reason).toBe("too_short");

    const missingOwner = fakeRes();
    await handleAuthSessionRoutes(
      localReq({
        method: "POST",
        pathname: "/api/auth/password/change",
        body: { newPassword: STRONG_PASSWORD },
      }),
      missingOwner.res,
      STATE_WITH_DB,
    );
    expect(missingOwner.status()).toBe(404);
    expect(missingOwner.body()).toEqual({ error: "owner_not_found" });

    const remoteNoSession = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/password/change",
        body: { newPassword: STRONG_PASSWORD },
      }),
      remoteNoSession.res,
      STATE_WITH_DB,
    );
    expect(remoteNoSession.status()).toBe(404);

    await seedOwner();
    seedSession({ id: "sess-pw", identityId: "owner-1" });
    const missingCurrent = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/password/change",
        cookie: `${SESSION_COOKIE_NAME}=sess-pw`,
        body: { newPassword: "new secure password 2!" },
      }),
      missingCurrent.res,
      STATE_WITH_DB,
    );
    expect(missingCurrent.status()).toBe(401);

    const badCurrent = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/password/change",
        cookie: `${SESSION_COOKIE_NAME}=sess-pw`,
        body: {
          currentPassword: "wrong-current-1",
          newPassword: "new secure password 2!",
        },
      }),
      badCurrent.res,
      STATE_WITH_DB,
    );
    expect(badCurrent.status()).toBe(401);

    // Failure paths above share IPs with the success/overflow cases; the
    // sensitive bucket is 5/min, so reset before measuring that window.
    _resetSensitiveLimiters();

    const localChange = fakeRes();
    await handleAuthSessionRoutes(
      localReq({
        method: "POST",
        pathname: "/api/auth/password/change",
        body: { newPassword: "new secure password 2!" },
      }),
      localChange.res,
      STATE_WITH_DB,
    );
    expect(localChange.status()).toBe(200);
    expect(localChange.body()).toEqual({ ok: true });

    for (let i = 0; i < 4; i += 1) {
      const res = fakeRes();
      await handleAuthSessionRoutes(
        localReq({
          method: "POST",
          pathname: "/api/auth/password/change",
          body: { newPassword: `new secure password ${i} x!` },
        }),
        res.res,
        STATE_WITH_DB,
      );
      expect(res.status()).toBe(200);
    }
    const blocked = fakeRes();
    await handleAuthSessionRoutes(
      localReq({
        method: "POST",
        pathname: "/api/auth/password/change",
        body: { newPassword: "new secure password blocked!" },
      }),
      blocked.res,
      STATE_WITH_DB,
    );
    expect(blocked.status()).toBe(429);
  });

  it("lists the synthetic local session plus stored sessions, and empty owner queues", async () => {
    const emptyLocal = fakeRes();
    await handleAuthSessionRoutes(
      localReq({ method: "GET", pathname: "/api/auth/sessions" }),
      emptyLocal.res,
      STATE_WITH_DB,
    );
    expect(emptyLocal.status()).toBe(200);
    const emptyBody = emptyLocal.body() as {
      sessions: Array<{ id: string; current: boolean }>;
    };
    expect(emptyBody.sessions).toHaveLength(1);
    expect(emptyBody.sessions[0]?.id).toBe("local-loopback");
    expect(emptyBody.sessions[0]?.current).toBe(true);

    await seedOwner();
    seedSession({
      id: "older",
      identityId: "owner-1",
      lastSeenAt: 1,
    });
    seedSession({
      id: "newer",
      identityId: "owner-1",
      lastSeenAt: 2,
    });
    const listed = fakeRes();
    await handleAuthSessionRoutes(
      localReq({ method: "GET", pathname: "/api/auth/sessions" }),
      listed.res,
      STATE_WITH_DB,
    );
    const listedBody = listed.body() as {
      sessions: Array<{ id: string; current: boolean }>;
    };
    expect(listedBody.sessions.map((s) => s.id)).toEqual([
      "local-loopback",
      "newer",
      "older",
    ]);
    expect(listedBody.sessions.slice(1).every((s) => s.current === false)).toBe(
      true,
    );

    const unauthorized = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({ method: "GET", pathname: "/api/auth/sessions" }),
      unauthorized.res,
      STATE_WITH_DB,
    );
    expect(unauthorized.status()).toBe(401);

    const authed = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "GET",
        pathname: "/api/auth/sessions",
        cookie: `${SESSION_COOKIE_NAME}=newer`,
      }),
      authed.res,
      STATE_WITH_DB,
    );
    expect(authed.status()).toBe(200);
    const authedBody = authed.body() as {
      sessions: Array<{ id: string; current: boolean }>;
    };
    expect(authedBody.sessions.find((s) => s.id === "newer")?.current).toBe(
      true,
    );
    expect(authedBody.sessions.find((s) => s.id === "older")?.current).toBe(
      false,
    );
  });

  it("revokes only the caller's session and clears cookies when revoking the current one", async () => {
    const unauth = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/sessions/missing/revoke",
      }),
      unauth.res,
      STATE_WITH_DB,
    );
    expect(unauth.status()).toBe(401);

    await seedOwner();
    seedSession({ id: "mine", identityId: "owner-1" });
    seedSession({ id: "other-person", identityId: "someone-else" });

    const missing = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/sessions/does-not-exist/revoke",
        cookie: `${SESSION_COOKIE_NAME}=mine`,
      }),
      missing.res,
      STATE_WITH_DB,
    );
    expect(missing.status()).toBe(404);
    expect(missing.body()).toEqual({ error: "session_not_found" });

    const foreign = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/sessions/other-person/revoke",
        cookie: `${SESSION_COOKIE_NAME}=mine`,
      }),
      foreign.res,
      STATE_WITH_DB,
    );
    expect(foreign.status()).toBe(404);

    seedSession({ id: "other-mine", identityId: "owner-1" });
    const other = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/sessions/other-mine/revoke",
        cookie: `${SESSION_COOKIE_NAME}=mine`,
      }),
      other.res,
      STATE_WITH_DB,
    );
    expect(other.status()).toBe(200);
    expect(other.body()).toEqual({ ok: true });
    expect(memory.sessions.get("other-mine")?.revokedAt).not.toBeNull();
    expect(other.cookies()).toEqual([]);

    const self = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/sessions/mine/revoke",
        cookie: `${SESSION_COOKIE_NAME}=mine`,
      }),
      self.res,
      STATE_WITH_DB,
    );
    expect(self.status()).toBe(200);
    expect(self.cookies().some((c) => c.includes("Max-Age=0"))).toBe(true);
    expect(memory.sessions.get("mine")?.revokedAt).not.toBeNull();
  });
});
