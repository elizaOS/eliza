/**
 * Sessions module tests.
 *
 * Pure helpers (CSRF derive/verify, cookie serialize/parse) run inline.
 * TTL math + sliding refresh exercise a real pglite-backed AuthStore so
 * the persistence layer is included — project memory: never mock SQL.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDatabaseAdapter,
  DatabaseMigrationService,
  type DrizzleDatabase,
  plugin as sqlPlugin,
} from "@elizaos/plugin-sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore } from "../../services/auth-store";
import {
  BROWSER_SESSION_REMEMBER_CAP_MS,
  BROWSER_SESSION_TTL_MS,
  CSRF_COOKIE_NAME,
  createBrowserSession,
  createMachineSession,
  deriveCsrfToken,
  findActiveSession,
  MACHINE_SESSION_TTL_MS,
  parseCookieHeader,
  parseSessionCookie,
  SESSION_COOKIE_NAME,
  serializeCsrfCookie,
  serializeCsrfExpiryCookie,
  serializeSessionCookie,
  serializeSessionExpiryCookie,
  verifyCsrfToken,
} from "./sessions";

interface AdapterWithDb {
  db?: unknown;
  initialize?: () => Promise<void>;
  init?: () => Promise<void>;
  close?: () => Promise<void>;
}

interface Harness {
  db: DrizzleDatabase;
  store: AuthStore;
  cleanup: () => Promise<void>;
}

async function open(): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "milady-sessions-"));
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
  return {
    db,
    store,
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

async function makeOwner(store: AuthStore, id = "ident-A"): Promise<string> {
  await store.createIdentity({
    id,
    kind: "owner",
    displayName: id,
    createdAt: 0,
  });
  return id;
}

describe("sessions: CSRF derive/verify", () => {
  it("derives a stable HMAC-SHA256 token", () => {
    const token = deriveCsrfToken({
      id: "session-id-1",
      csrfSecret: "secret-1",
    });
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const again = deriveCsrfToken({
      id: "session-id-1",
      csrfSecret: "secret-1",
    });
    expect(again).toBe(token);
  });

  it("verify returns true for the matching token", () => {
    const session = { id: "sid", csrfSecret: "secret" };
    const token = deriveCsrfToken(session);
    expect(verifyCsrfToken(session, token)).toBe(true);
  });

  it("verify returns false for tampered token, missing token, empty string", () => {
    const session = { id: "sid", csrfSecret: "secret" };
    const token = deriveCsrfToken(session);
    expect(verifyCsrfToken(session, `${token}x`)).toBe(false);
    expect(verifyCsrfToken(session, null)).toBe(false);
    expect(verifyCsrfToken(session, undefined)).toBe(false);
    expect(verifyCsrfToken(session, "")).toBe(false);
  });
});

describe("sessions: cookie serialize/parse", () => {
  it("serializes a session cookie with HttpOnly, SameSite=Lax, Path=/", () => {
    const cookie = serializeSessionCookie(
      { id: "abc", expiresAt: Date.now() + 60_000 },
      { env: { ELIZA_API_BIND: "0.0.0.0" } },
    );
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=abc`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    // Non-loopback bind => Secure must be present.
    expect(cookie).toContain("Secure");
  });

  it("drops Secure on loopback bind", () => {
    const cookie = serializeSessionCookie(
      { id: "abc", expiresAt: Date.now() + 60_000 },
      { env: { ELIZA_API_BIND: "127.0.0.1" } },
    );
    expect(cookie).not.toContain("Secure");
  });

  it("CSRF cookie is readable (no HttpOnly)", () => {
    const session = {
      id: "sid",
      csrfSecret: "secret",
      expiresAt: Date.now() + 60_000,
    };
    const cookie = serializeCsrfCookie(session, {
      env: { ELIZA_API_BIND: "127.0.0.1" },
    });
    expect(cookie).toContain(`${CSRF_COOKIE_NAME}=`);
    expect(cookie).not.toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("expiry cookie has Max-Age=0", () => {
    const expired = serializeSessionExpiryCookie({
      env: { ELIZA_API_BIND: "127.0.0.1" },
    });
    expect(expired).toContain("Max-Age=0");
    const expiredCsrf = serializeCsrfExpiryCookie({
      env: { ELIZA_API_BIND: "127.0.0.1" },
    });
    expect(expiredCsrf).toContain("Max-Age=0");
  });

  it("parseCookieHeader handles multi-cookie, whitespace, percent-encoded", () => {
    const map = parseCookieHeader(
      "milady_session=abc%3Ddef; milady_csrf=xyz; foo=bar",
    );
    expect(map.get("milady_session")).toBe("abc=def");
    expect(map.get("milady_csrf")).toBe("xyz");
    expect(map.get("foo")).toBe("bar");
  });

  it("parseCookieHeader returns empty map on null/empty header", () => {
    expect(parseCookieHeader(null).size).toBe(0);
    expect(parseCookieHeader("").size).toBe(0);
  });

  it("parseSessionCookie reads from request headers", () => {
    const req = {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=xyz; ${CSRF_COOKIE_NAME}=abc`,
      },
    };
    expect(parseSessionCookie(req)).toBe("xyz");
  });

  it("parseSessionCookie returns null when missing", () => {
    expect(parseSessionCookie({ headers: {} })).toBeNull();
    expect(parseSessionCookie({ headers: { cookie: "" } })).toBeNull();
  });
});

describe("sessions: TTL math + sliding refresh", () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await open();
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  it("createBrowserSession produces a 12h sliding TTL", async () => {
    const id = await makeOwner(harness.store, "owner-1");
    const now = 1_000_000;
    const { session } = await createBrowserSession(harness.store, {
      identityId: id,
      ip: "127.0.0.1",
      userAgent: "vitest",
      rememberDevice: false,
      now,
    });
    expect(session.expiresAt - now).toBe(BROWSER_SESSION_TTL_MS);
    expect(session.kind).toBe("browser");
  });

  it("findActiveSession slides expiry forward up to remember cap", async () => {
    const id = await makeOwner(harness.store, "owner-2");
    const now = 1_000_000;
    const { session } = await createBrowserSession(harness.store, {
      identityId: id,
      ip: null,
      userAgent: null,
      rememberDevice: true,
      now,
    });
    // Fast-forward past most of the sliding window.
    const later = now + BROWSER_SESSION_TTL_MS - 1_000;
    const refreshed = await findActiveSession(harness.store, session.id, later);
    expect(refreshed).not.toBeNull();
    expect(refreshed?.lastSeenAt).toBe(later);
    // Slide cannot exceed createdAt + remember cap (30 days).
    expect(refreshed?.expiresAt).toBeLessThanOrEqual(
      session.createdAt + BROWSER_SESSION_REMEMBER_CAP_MS,
    );
  });

  it("findActiveSession returns null past the absolute cap", async () => {
    const id = await makeOwner(harness.store, "owner-3");
    const now = 1_000_000;
    const { session } = await createBrowserSession(harness.store, {
      identityId: id,
      ip: null,
      userAgent: null,
      rememberDevice: false,
      now,
    });
    const waaayLater = now + BROWSER_SESSION_TTL_MS + 1;
    const expired = await findActiveSession(
      harness.store,
      session.id,
      waaayLater,
    );
    expect(expired).toBeNull();
  });

  it("createMachineSession is absolute (no sliding extension)", async () => {
    const id = await makeOwner(harness.store, "owner-4");
    const now = 1_000_000;
    const { session } = await createMachineSession(harness.store, {
      identityId: id,
      scopes: ["legacy"],
      label: "ci-bot",
      ip: null,
      now,
    });
    expect(session.expiresAt - now).toBe(MACHINE_SESSION_TTL_MS);
    const later = now + 60_000;
    const refreshed = await findActiveSession(harness.store, session.id, later);
    expect(refreshed).not.toBeNull();
    // Machine sessions don't extend expiry on access.
    expect(refreshed?.expiresAt).toBe(session.expiresAt);
    expect(refreshed?.lastSeenAt).toBe(later);
  });

  it("revoked session lookup returns null", async () => {
    const id = await makeOwner(harness.store, "owner-5");
    const { session } = await createBrowserSession(harness.store, {
      identityId: id,
      ip: null,
      userAgent: null,
      rememberDevice: false,
      now: 1_000_000,
    });
    await harness.store.revokeSession(session.id, 1_000_005);
    const found = await findActiveSession(harness.store, session.id, 1_000_010);
    expect(found).toBeNull();
  });
});
