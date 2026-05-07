/**
 * Real-pglite integration test for the P1 session routes.
 *
 * Drives the route handler directly with synthetic req/res objects so the
 * full route logic — JSON body parsing, cookie minting, audit emission —
 * runs end-to-end without needing a live HTTP server.
 */

import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  createDatabaseAdapter,
  DatabaseMigrationService,
  type DrizzleDatabase,
  plugin as sqlPlugin,
} from "@elizaos/plugin-sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore } from "../services/auth-store";
import { _resetAuthRateLimiter } from "./auth";
import { SESSION_COOKIE_NAME } from "./auth/sessions";
import {
  _resetAuthSessionRoutesLimiter,
  handleAuthSessionRoutes,
} from "./auth-session-routes";
import type { CompatRuntimeState } from "./compat-route-shared";

interface AdapterWithDb {
  db?: unknown;
  initialize?: () => Promise<void>;
  init?: () => Promise<void>;
  close?: () => Promise<void>;
  ready?: boolean;
}

interface Harness {
  db: DrizzleDatabase;
  store: AuthStore;
  state: CompatRuntimeState;
  cleanup: () => Promise<void>;
}

async function open(): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-routes-"));
  const adapter = createDatabaseAdapter(
    { dataDir },
    "00000000-0000-0000-0000-000000000001" as `${string}-${string}-${string}-${string}-${string}`,
  ) as unknown as AdapterWithDb;
  if (typeof adapter.initialize === "function") await adapter.initialize();
  else if (typeof adapter.init === "function") await adapter.init();
  if (!adapter.db) throw new Error("test harness: adapter has no .db");
  const db = adapter.db as DrizzleDatabase;
  const migrations = new DatabaseMigrationService();
  await migrations.initializeWithDatabase(db);
  migrations.discoverAndRegisterPluginSchemas([sqlPlugin]);
  await migrations.runAllPluginMigrations();
  const store = new AuthStore(db);

  // Build a minimal CompatRuntimeState that exposes adapter.db to the
  // route handler. The handler only reads `state.current.adapter.db`.
  const state: CompatRuntimeState = {
    current: {
      adapter: { db },
    } as unknown as CompatRuntimeState["current"],
    pendingAgentName: null,
    pendingRestartReasons: [],
  };

  return {
    db,
    store,
    state,
    cleanup: async () => {
      try {
        await adapter.close?.();
      } catch {
        // best effort
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

interface FakeRes {
  res: http.ServerResponse;
  body(): unknown;
  status(): number;
  cookies(): string[];
  headers(): Record<string, string>;
}

function fakeRes(): FakeRes {
  let bodyText = "";
  const headers: Record<string, string> = {};
  const cookies: string[] = [];
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader(name: string, value: string | string[]) {
      const key = name.toLowerCase();
      if (key === "set-cookie") {
        if (Array.isArray(value)) cookies.push(...value);
        else cookies.push(value);
        return;
      }
      headers[key] = Array.isArray(value) ? value.join(", ") : value;
    },
    end(chunk?: string | Buffer) {
      if (typeof chunk === "string") bodyText += chunk;
      else if (chunk) bodyText += chunk.toString("utf8");
    },
  } as unknown as http.ServerResponse;
  return {
    res,
    body() {
      return bodyText.length > 0 ? JSON.parse(bodyText) : null;
    },
    status() {
      return (res as unknown as { statusCode: number }).statusCode;
    },
    cookies() {
      return cookies;
    },
    headers() {
      return headers;
    },
  };
}

function fakeReq(opts: {
  method: string;
  pathname: string;
  body?: unknown;
  cookie?: string;
  bearer?: string;
  ip?: string;
  headers?: http.IncomingHttpHeaders;
}): http.IncomingMessage {
  const bodyStr = opts.body === undefined ? "" : JSON.stringify(opts.body);
  const stream = Readable.from([bodyStr]) as unknown as http.IncomingMessage;
  const headers: http.IncomingHttpHeaders = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  Object.assign(stream, {
    method: opts.method,
    url: opts.pathname,
    headers,
    socket: {
      remoteAddress: opts.ip ?? "127.0.0.1",
    },
  });
  return stream;
}

function extractSessionCookieValue(cookies: string[]): string | null {
  for (const c of cookies) {
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(c);
    if (match) {
      const v = match[1];
      if (!v) return null;
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return null;
}

describe("P1 session routes (real pglite)", () => {
  const HARNESS_HOOK_TIMEOUT_MS = 120_000;
  let harness: Harness;

  beforeEach(async () => {
    harness = await open();
    _resetAuthRateLimiter();
    _resetAuthSessionRoutesLimiter();
    delete process.env.ELIZA_API_TOKEN;
    delete process.env.ELIZA_CLOUD_PROVISIONED;
  }, HARNESS_HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await harness.cleanup();
    delete process.env.ELIZA_API_TOKEN;
    delete process.env.ELIZA_CLOUD_PROVISIONED;
  });

  it("setup -> me -> logout flow", async () => {
    // POST /api/auth/setup
    const setupReq = fakeReq({
      method: "POST",
      pathname: "/api/auth/setup",
      body: {
        password: "correct-horse battery 9!",
        displayName: "alice",
      },
    });
    const setupRes = fakeRes();
    const handled = await handleAuthSessionRoutes(
      setupReq,
      setupRes.res,
      harness.state,
    );
    expect(handled).toBe(true);
    expect(setupRes.status()).toBe(200);
    const setupBody = setupRes.body() as {
      identity: { id: string; displayName: string; kind: string };
      session: { id: string; expiresAt: number };
      csrfToken: string;
    };
    expect(setupBody.identity.displayName).toBe("alice");
    expect(setupBody.identity.kind).toBe("owner");
    expect(setupBody.csrfToken).toMatch(/^[a-f0-9]{64}$/);
    const sessionId = extractSessionCookieValue(setupRes.cookies());
    expect(sessionId).not.toBeNull();
    expect(sessionId).toBe(setupBody.session.id);

    // /api/auth/me with the cookie
    const meReq = fakeReq({
      method: "GET",
      pathname: "/api/auth/me",
      cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
    });
    const meRes = fakeRes();
    await handleAuthSessionRoutes(meReq, meRes.res, harness.state);
    expect(meRes.status()).toBe(200);
    const meBody = meRes.body() as {
      identity: { id: string };
      session: { id: string };
    };
    expect(meBody.identity.id).toBe(setupBody.identity.id);

    // /api/auth/logout — destroys the session
    const logoutReq = fakeReq({
      method: "POST",
      pathname: "/api/auth/logout",
      cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
    });
    const logoutRes = fakeRes();
    await handleAuthSessionRoutes(logoutReq, logoutRes.res, harness.state);
    expect(logoutRes.status()).toBe(200);
    // /me with the now-revoked cookie returns 401
    const meAfterReq = fakeReq({
      method: "GET",
      pathname: "/api/auth/me",
      cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
      ip: "10.0.0.8",
    });
    const meAfterRes = fakeRes();
    await handleAuthSessionRoutes(meAfterReq, meAfterRes.res, harness.state);
    expect(meAfterRes.status()).toBe(401);
  });

  it("local /api/auth/me succeeds without a password session", async () => {
    const res = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "GET",
        pathname: "/api/auth/me",
        headers: { host: "localhost:31337" },
      }),
      res.res,
      harness.state,
    );

    expect(res.status()).toBe(200);
    const body = res.body() as {
      session: { kind: string; expiresAt: number | null };
      access: {
        mode: string;
        passwordConfigured: boolean;
        ownerConfigured: boolean;
      };
    };
    expect(body.session.kind).toBe("local");
    expect(body.session.expiresAt).toBeNull();
    expect(body.access.mode).toBe("local");
    expect(body.access.passwordConfigured).toBe(false);
    expect(body.access.ownerConfigured).toBe(false);
  });

  it("setup is one-shot — second call returns 409", async () => {
    const first = fakeReq({
      method: "POST",
      pathname: "/api/auth/setup",
      body: { password: "first-strong-password 1!", displayName: "alice" },
    });
    const firstRes = fakeRes();
    await handleAuthSessionRoutes(first, firstRes.res, harness.state);
    expect(firstRes.status()).toBe(200);

    const second = fakeReq({
      method: "POST",
      pathname: "/api/auth/setup",
      body: {
        password: "another-strong-password 2!",
        displayName: "bob",
      },
    });
    const secondRes = fakeRes();
    await handleAuthSessionRoutes(second, secondRes.res, harness.state);
    expect(secondRes.status()).toBe(409);
  });

  it("setup rejects weak passwords", async () => {
    const req = fakeReq({
      method: "POST",
      pathname: "/api/auth/setup",
      body: { password: "short", displayName: "alice" },
    });
    const res = fakeRes();
    await handleAuthSessionRoutes(req, res.res, harness.state);
    expect(res.status()).toBe(400);
    expect((res.body() as { reason: string }).reason).toBe("too_short");
  });

  it("login/password rejects bad password and accepts good password", async () => {
    // setup first
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/setup",
        body: {
          password: "good password 1234!",
          displayName: "alice",
        },
      }),
      fakeRes().res,
      harness.state,
    );

    const bad = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/login/password",
        body: { displayName: "alice", password: "wrong-pw" },
      }),
      bad.res,
      harness.state,
    );
    expect(bad.status()).toBe(401);

    const good = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/login/password",
        body: {
          displayName: "alice",
          password: "good password 1234!",
        },
      }),
      good.res,
      harness.state,
    );
    expect(good.status()).toBe(200);
    expect(extractSessionCookieValue(good.cookies())).not.toBeNull();
  });

  it("local access can set a remote password without current password", async () => {
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/setup",
        body: {
          password: "initial secure password 1!",
          displayName: "alice",
        },
      }),
      fakeRes().res,
      harness.state,
    );

    const change = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/password/change",
        body: { newPassword: "new secure password 2!" },
        headers: { host: "localhost:31337" },
      }),
      change.res,
      harness.state,
    );
    expect(change.status()).toBe(200);

    const oldLogin = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/login/password",
        ip: "10.0.0.8",
        body: {
          displayName: "alice",
          password: "initial secure password 1!",
        },
      }),
      oldLogin.res,
      harness.state,
    );
    expect(oldLogin.status()).toBe(401);

    const newLogin = fakeRes();
    await handleAuthSessionRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/login/password",
        ip: "10.0.0.8",
        body: {
          displayName: "alice",
          password: "new secure password 2!",
        },
      }),
      newLogin.res,
      harness.state,
    );
    expect(newLogin.status()).toBe(200);
  });

  it("route auth trusts localhost only, not remote or cloud loopback", async () => {
    process.env.ELIZA_API_TOKEN = "configured-token-value";
    const { ensureCompatApiAuthorizedAsync, _resetAuthRateLimiter: reset } =
      await import("./auth");
    reset();

    const local = fakeRes();
    const localOk = await ensureCompatApiAuthorizedAsync(
      fakeReq({
        method: "GET",
        pathname: "/api/secure",
        headers: { host: "localhost:31337" },
      }),
      local.res,
      { store: harness.store },
    );
    expect(localOk).toBe(true);

    const remote = fakeRes();
    const remoteOk = await ensureCompatApiAuthorizedAsync(
      fakeReq({
        method: "GET",
        pathname: "/api/secure",
        ip: "10.0.0.8",
        headers: { host: "10.0.0.2:31337" },
      }),
      remote.res,
      { store: harness.store },
    );
    expect(remoteOk).toBe(false);
    expect(remote.status()).toBe(401);

    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    reset();
    const cloudLocal = fakeRes();
    const cloudLocalOk = await ensureCompatApiAuthorizedAsync(
      fakeReq({
        method: "GET",
        pathname: "/api/secure",
        headers: { host: "localhost:31337" },
      }),
      cloudLocal.res,
      { store: harness.store },
    );
    expect(cloudLocalOk).toBe(false);
    expect(cloudLocal.status()).toBe(401);
  });

  it("route auth rejects localhost trust when proxy headers report remote clients", async () => {
    process.env.ELIZA_API_TOKEN = "configured-token-value";
    const { ensureCompatApiAuthorizedAsync, _resetAuthRateLimiter: reset } =
      await import("./auth");

    const cases: Array<{
      name: string;
      headers: http.IncomingHttpHeaders;
    }> = [
      {
        name: "Forwarded",
        headers: { forwarded: 'for="[::1]", for=203.0.113.8' },
      },
      {
        name: "X-Forwarded-For",
        headers: { "x-forwarded-for": "127.0.0.1, 203.0.113.9" },
      },
      { name: "X-Real-IP", headers: { "x-real-ip": "198.51.100.4" } },
      { name: "X-Client-IP", headers: { "x-client-ip": "198.51.100.5" } },
      {
        name: "CF-Connecting-IP",
        headers: { "cf-connecting-ip": "2001:db8::1" },
      },
      {
        name: "True-Client-IP",
        headers: { "true-client-ip": "203.0.113.10:443" },
      },
      {
        name: "similar client IP header",
        headers: { "fastly-client-ip": "198.51.100.6" },
      },
    ];

    for (const testCase of cases) {
      reset();
      const res = fakeRes();
      const ok = await ensureCompatApiAuthorizedAsync(
        fakeReq({
          method: "GET",
          pathname: "/api/secure",
          headers: {
            host: "localhost:31337",
            ...testCase.headers,
          },
        }),
        res.res,
        { store: harness.store },
      );
      expect(ok, testCase.name).toBe(false);
      expect(res.status(), testCase.name).toBe(401);
    }
  });
});
