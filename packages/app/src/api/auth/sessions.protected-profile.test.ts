/**
 * Automatic logoff under the protected profile (HIPAA §164.312(a)(2)(iii)),
 * against a real PGlite auth store: 30-minute sliding idle timeout, a hard
 * 12h cap that "remember device" cannot extend, and an idle override read
 * only from the environment frozen at process entry.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureProtectedProfile } from "@elizaos/agent/security/protected-profile-state";
import {
  createDatabaseAdapter,
  plugin as sqlPlugin,
} from "@elizaos/plugin-sql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthStore, type DrizzleDatabase } from "../../services/auth-store";
import {
  BROWSER_SESSION_TTL_MS,
  createBrowserSession,
  createMachineSession,
  findActiveSession,
  MACHINE_SESSION_TTL_MS,
  PROTECTED_BROWSER_SESSION_IDLE_MS,
  resolveBrowserSessionPolicy,
  SESSION_IDLE_MINUTES_ENV,
  serializeSessionCookie,
} from "./sessions";

// The profile is captured once, as the host entrypoint does before any
// configuration loads; this isolated test process plays that entry.
vi.hoisted(() => {
  process.env.ELIZA_PROTECTED_PROFILE = "dstack-cpu";
  delete process.env.ELIZA_SESSION_IDLE_MINUTES;
});

const MINUTE = 60 * 1000;
let stateDir: string;
let adapter: ReturnType<typeof createDatabaseAdapter>;
let store: AuthStore;
let identityId: string;

describe("browser session automatic logoff (protected profile)", {
  concurrent: false,
}, () => {
  beforeAll(async () => {
    expect(captureProtectedProfile().profile).toBe("dstack-cpu");
    stateDir = await mkdtemp(path.join(tmpdir(), "eliza-session-protected-"));
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

  afterAll(async () => {
    vi.unstubAllEnvs();
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

  it("uses a 30-minute idle window and a 12h cap even with remember-device", () => {
    expect(resolveBrowserSessionPolicy()).toEqual({
      idleMs: PROTECTED_BROWSER_SESSION_IDLE_MS,
      absoluteCapMs: BROWSER_SESSION_TTL_MS,
      rememberCapMs: BROWSER_SESSION_TTL_MS,
      activityTracked: true,
    });
  });

  it("slides on activity and logs off after 30 idle minutes", async () => {
    const t0 = Date.now();
    const { session } = await browser(t0, false);
    expect(session.expiresAt).toBe(t0 + 30 * MINUTE);
    const t1 = t0 + 25 * MINUTE;
    expect(
      (await findActiveSession(store, session.id, t1, { lastActivityAt: t1 }))
        ?.expiresAt,
    ).toBe(t1 + 30 * MINUTE);
    expect(
      await findActiveSession(store, session.id, t1 + 30 * MINUTE),
    ).toBeNull();
  });

  it("ends an active remember-device session at 12h from creation", async () => {
    const t0 = Date.now();
    const { session } = await browser(t0, true);
    let now = t0;
    // Stay active every 20 minutes right up to the cap.
    while (now + 20 * MINUTE < t0 + BROWSER_SESSION_TTL_MS) {
      now += 20 * MINUTE;
      const active = await findActiveSession(store, session.id, now, {
        lastActivityAt: now,
      });
      expect(active?.expiresAt).toBe(
        Math.min(now + 30 * MINUTE, t0 + BROWSER_SESSION_TTL_MS),
      );
    }
    expect(
      await findActiveSession(store, session.id, t0 + BROWSER_SESSION_TTL_MS),
    ).toBeNull();
  });

  it("sets a cookie that lives to the absolute cap, not the idle expiry", async () => {
    const { session } = await browser(Date.now(), true);
    const maxAge = Number(
      /Max-Age=(\d+)/.exec(serializeSessionCookie(session, { env: {} }))?.[1],
    );
    expect(maxAge).toBeGreaterThan(BROWSER_SESSION_TTL_MS / 1000 - 60);
    expect(maxAge).toBeLessThanOrEqual(BROWSER_SESSION_TTL_MS / 1000);
  });

  it("ignores idle overrides written after entry", async () => {
    vi.stubEnv(SESSION_IDLE_MINUTES_ENV, "600");
    expect(resolveBrowserSessionPolicy().idleMs).toBe(
      PROTECTED_BROWSER_SESSION_IDLE_MS,
    );
  });

  it("leaves device-bound machine sessions on their absolute TTL", async () => {
    const t0 = Date.now();
    const { session } = await createMachineSession(store, {
      identityId,
      scopes: [],
      now: t0,
    });
    const later = t0 + 7 * 24 * 60 * MINUTE;
    expect((await findActiveSession(store, session.id, later))?.expiresAt).toBe(
      t0 + MACHINE_SESSION_TTL_MS,
    );
  });
});
