/**
 * Browser-session lifetime on an ordinary host, against a real PGlite auth
 * store: the historical 12h sliding window (30 days with "remember device")
 * is unchanged, and `ELIZA_SESSION_IDLE_MINUTES` adds an idle timeout.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import {
  createDatabaseAdapter,
  plugin as sqlPlugin,
} from "@elizaos/plugin-sql";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AuthStore, type DrizzleDatabase } from "../../services/auth-store";
import { resolveAuthorizedRouteRole } from "../auth";
import {
  BROWSER_SESSION_REMEMBER_CAP_MS,
  BROWSER_SESSION_TTL_MS,
  createBrowserSession,
  createMachineSession,
  findActiveSession,
  LAST_ACTIVITY_HEADER_NAME,
  MACHINE_SESSION_TTL_MS,
  readLastActivityHeader,
  resolveBrowserSessionPolicy,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_MINUTES_ENV,
} from "./sessions";

const MINUTE = 60 * 1000;
let stateDir: string;
let adapter: ReturnType<typeof createDatabaseAdapter>;
let store: AuthStore;
let identityId: string;

describe("browser session idle timeout (ordinary host)", {
  concurrent: false,
}, () => {
  beforeAll(async () => {
    delete process.env.ELIZA_PROTECTED_PROFILE;
    stateDir = await mkdtemp(path.join(tmpdir(), "eliza-session-idle-"));
    adapter = createDatabaseAdapter(
      { dataDir: path.join(stateDir, "db") },
      randomUUID(),
    );
    await adapter.initialize();
    const db = adapter.db;
    if (!db || !adapter.runPluginMigrations) {
      throw new Error("PGlite adapter did not expose its database");
    }
    await adapter.runPluginMigrations([sqlPlugin]);
    store = new AuthStore(db as DrizzleDatabase);
    identityId = (
      await store.createIdentity({
        id: randomUUID(),
        kind: "owner",
        displayName: "Synthetic owner",
        createdAt: Date.now(),
      })
    ).id;
  }, 120_000);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (adapter) await adapter.close();
    if (stateDir)
      await rm(stateDir, { recursive: true, force: true, maxRetries: 5 });
  });

  const browser = (now: number, rememberDevice: boolean) =>
    createBrowserSession(store, {
      identityId,
      ip: null,
      userAgent: null,
      rememberDevice,
      now,
    });

  it("keeps the historical sliding window without an override", async () => {
    expect(resolveBrowserSessionPolicy()).toEqual({
      idleMs: BROWSER_SESSION_TTL_MS,
      absoluteCapMs: BROWSER_SESSION_TTL_MS,
      rememberCapMs: BROWSER_SESSION_REMEMBER_CAP_MS,
      activityTracked: false,
    });
    const t0 = Date.now();
    const { session } = await browser(t0, true);
    expect(session.expiresAt).toBe(t0 + BROWSER_SESSION_TTL_MS);
    // Remember-device slides past 12h from creation.
    const t1 = t0 + 11 * 60 * MINUTE;
    const t2 = t1 + 11 * 60 * MINUTE;
    expect((await findActiveSession(store, session.id, t1))?.expiresAt).toBe(
      t1 + BROWSER_SESSION_TTL_MS,
    );
    expect((await findActiveSession(store, session.id, t2))?.expiresAt).toBe(
      t2 + BROWSER_SESSION_TTL_MS,
    );
  });

  it("applies ELIZA_SESSION_IDLE_MINUTES as an activity-driven idle timeout", async () => {
    vi.stubEnv(SESSION_IDLE_MINUTES_ENV, "15");
    expect(resolveBrowserSessionPolicy()).toMatchObject({
      idleMs: 15 * MINUTE,
      activityTracked: true,
    });
    const t0 = Date.now();
    const { session } = await browser(t0, false);
    expect(session.expiresAt).toBe(t0 + 15 * MINUTE);
    // The user interacted at t0+13m; the request arrives a minute later.
    const active = await findActiveSession(
      store,
      session.id,
      t0 + 14 * MINUTE,
      {
        lastActivityAt: t0 + 13 * MINUTE,
      },
    );
    expect(active?.lastSeenAt).toBe(t0 + 13 * MINUTE);
    expect(active?.expiresAt).toBe(t0 + 28 * MINUTE);
    // Idle for the full window after the last interaction: logged off.
    expect(
      await findActiveSession(store, session.id, t0 + 28 * MINUTE),
    ).toBeNull();
  });

  it("lets a session expire under background polling without activity", async () => {
    vi.stubEnv(SESSION_IDLE_MINUTES_ENV, "15");
    const t0 = Date.now();
    const { session } = await browser(t0, false);
    // A status poll every minute authenticates but never slides the window.
    for (let minute = 1; minute < 15; minute += 1) {
      const polled = await findActiveSession(
        store,
        session.id,
        t0 + minute * MINUTE,
      );
      expect(polled?.expiresAt).toBe(t0 + 15 * MINUTE);
      expect(polled?.lastSeenAt).toBe(t0);
    }
    expect(
      await findActiveSession(store, session.id, t0 + 15 * MINUTE),
    ).toBeNull();
  });

  it("keeps a session alive while the header reports recent activity", async () => {
    vi.stubEnv(SESSION_IDLE_MINUTES_ENV, "15");
    const t0 = Date.now();
    const { session } = await browser(t0, false);
    for (let minute = 10; minute <= 60; minute += 10) {
      const now = t0 + minute * MINUTE;
      const active = await findActiveSession(store, session.id, now, {
        lastActivityAt: now - 30_000,
      });
      expect(active?.expiresAt).toBe(now - 30_000 + 15 * MINUTE);
    }
  });

  it("ignores forged future and pre-session activity claims", async () => {
    vi.stubEnv(SESSION_IDLE_MINUTES_ENV, "15");
    const t0 = Date.now();
    const { session } = await browser(t0, false);
    const now = t0 + 5 * MINUTE;
    for (const lastActivityAt of [
      now + 60 * MINUTE,
      Number.MAX_SAFE_INTEGER,
      t0 - MINUTE,
    ]) {
      const active = await findActiveSession(store, session.id, now, {
        lastActivityAt,
      });
      expect(active?.expiresAt).toBe(t0 + 15 * MINUTE);
      expect(active?.lastSeenAt).toBe(t0);
    }
    expect(
      await findActiveSession(store, session.id, t0 + 15 * MINUTE, {
        lastActivityAt: t0 + 60 * MINUTE,
      }),
    ).toBeNull();
  });

  it("slides only on the activity header at the request auth gate", async () => {
    vi.stubEnv(SESSION_IDLE_MINUTES_ENV, "15");
    const t0 = Date.now();
    const { session } = await browser(t0, false);
    const request = (headers: Record<string, string>) => ({
      method: "GET",
      socket: { remoteAddress: "203.0.113.7" },
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${session.id}`,
        ...headers,
      },
    });
    const authorize = (now: number, headers: Record<string, string> = {}) =>
      resolveAuthorizedRouteRole(
        request(headers) as unknown as Parameters<
          typeof resolveAuthorizedRouteRole
        >[0],
        { store, allowTrustedLocalBypass: false, now },
      );
    expect((await authorize(t0 + 5 * MINUTE)).ok).toBe(true);
    expect((await store.findSession(session.id, t0))?.expiresAt).toBe(
      t0 + 15 * MINUTE,
    );
    expect(
      (
        await authorize(t0 + 10 * MINUTE, {
          [LAST_ACTIVITY_HEADER_NAME]: String(t0 + 9 * MINUTE),
        })
      ).ok,
    ).toBe(true);
    expect((await store.findSession(session.id, t0))?.expiresAt).toBe(
      t0 + 24 * MINUTE,
    );
    expect((await authorize(t0 + 24 * MINUTE)).ok).toBe(false);
  });

  it("parses the activity header strictly", () => {
    const req = (value: string | undefined) => ({
      headers: { [LAST_ACTIVITY_HEADER_NAME]: value },
    });
    expect(readLastActivityHeader(req("1700000000000"))).toBe(1700000000000);
    for (const bad of [undefined, "", "-1", "1.5", "1e12", "abc"]) {
      expect(readLastActivityHeader(req(bad))).toBeNull();
    }
  });

  it("expires a session idle past the window even when stored expiry is later", async () => {
    const t0 = Date.now();
    // Minted under the default 12h window, then the operator lowers idle.
    const { session } = await browser(t0, false);
    vi.stubEnv(SESSION_IDLE_MINUTES_ENV, "10");
    expect(
      await findActiveSession(store, session.id, t0 + 10 * MINUTE),
    ).toBeNull();
  });

  it("leaves machine sessions on their absolute TTL", async () => {
    vi.stubEnv(SESSION_IDLE_MINUTES_ENV, "1");
    const t0 = Date.now();
    const { session } = await createMachineSession(store, {
      identityId,
      scopes: [],
      now: t0,
    });
    const later = t0 + 24 * 60 * MINUTE;
    expect((await findActiveSession(store, session.id, later))?.expiresAt).toBe(
      t0 + MACHINE_SESSION_TTL_MS,
    );
  });

  it("rejects an invalid idle override with a typed error", async () => {
    for (const raw of ["0", "-5", "1.5", "abc", "15m"]) {
      vi.stubEnv(SESSION_IDLE_MINUTES_ENV, raw);
      let caught: unknown;
      try {
        resolveBrowserSessionPolicy();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ElizaError);
      expect((caught as ElizaError).code).toBe(
        "AUTH_SESSION_IDLE_MINUTES_INVALID",
      );
      await expect(browser(Date.now(), false)).rejects.toMatchObject({
        code: "AUTH_SESSION_IDLE_MINUTES_INVALID",
      });
    }
  });
});
