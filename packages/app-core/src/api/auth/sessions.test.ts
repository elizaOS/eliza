/**
 * Tests session lifecycle helpers in `sessions.ts`: browser/machine minting,
 * sliding-window lookup and caps, CSRF derive/verify, cookie serialize/parse,
 * and revoke (single + all-but-current). Drives the real module against an
 * in-memory AuthStore collaborator; CSRF uses the real HMAC-SHA256 derivation.
 */
import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppendAuditEventInput,
  AuthSessionRow,
  AuthStore,
  CreateSessionInput,
} from "../../services/auth-store";
import {
  BROWSER_SESSION_REMEMBER_CAP_MS,
  BROWSER_SESSION_TTL_MS,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  createBrowserSession,
  createMachineSession,
  denyOnAuthStoreError,
  deriveCsrfToken,
  findActiveSession,
  MACHINE_SESSION_TTL_MS,
  parseCookieHeader,
  parseSessionCookie,
  revokeAllSessionsForIdentity,
  revokeSession,
  SESSION_COOKIE_NAME,
  serializeCsrfCookie,
  serializeCsrfExpiryCookie,
  serializeSessionCookie,
  serializeSessionExpiryCookie,
  verifyCsrfToken,
} from "./sessions";

const NOW = 1_700_000_000_000;
const OWNER_ID = "identity-owner-1";
const HEX64 = /^[0-9a-f]{64}$/;

const LOOPBACK_ENV = { ELIZA_API_BIND: "127.0.0.1" };
const PUBLIC_ENV = { ELIZA_API_BIND: "203.0.113.10" };

function expectedCsrfToken(session: {
  id: string;
  csrfSecret: string;
}): string {
  return createHmac("sha256", session.csrfSecret)
    .update(`csrf:${session.id}`)
    .digest("hex");
}

function sessionRow(overrides: Partial<AuthSessionRow> = {}): AuthSessionRow {
  return {
    id: "session-browser-1",
    identityId: OWNER_ID,
    kind: "browser",
    createdAt: NOW,
    lastSeenAt: NOW,
    expiresAt: NOW + BROWSER_SESSION_TTL_MS,
    rememberDevice: false,
    csrfSecret: "csrf-secret-not-empty",
    ip: "127.0.0.1",
    userAgent: "vitest",
    scopes: [],
    revokedAt: null,
    ...overrides,
  };
}

class FakeAuthStore {
  public readonly sessions = new Map<string, AuthSessionRow>();
  public readonly auditEvents: AppendAuditEventInput[] = [];
  public readonly createCalls: CreateSessionInput[] = [];
  public readonly findCalls: Array<{ id: string; now: number }> = [];
  public readonly touchCalls: Array<{
    id: string;
    lastSeenAt: number;
    expiresAt: number;
  }> = [];
  public readonly revokeCalls: Array<{ id: string; now: number }> = [];
  public readonly revokeAllCalls: Array<{
    identityId: string;
    now: number;
    exceptSessionId: string | undefined;
  }> = [];
  public failFindSession = false;

  seed(row: AuthSessionRow): this {
    this.sessions.set(row.id, { ...row, scopes: [...row.scopes] });
    return this;
  }

  async createSession(input: CreateSessionInput): Promise<AuthSessionRow> {
    this.createCalls.push({ ...input, scopes: [...input.scopes] });
    const row: AuthSessionRow = {
      ...input,
      scopes: [...input.scopes],
      revokedAt: null,
    };
    this.sessions.set(row.id, row);
    return { ...row, scopes: [...row.scopes] };
  }

  async findSession(
    id: string,
    now: number = Date.now(),
  ): Promise<AuthSessionRow | null> {
    this.findCalls.push({ id, now });
    if (this.failFindSession) {
      throw new Error("session db down");
    }
    const found = this.sessions.get(id);
    if (!found) return null;
    if (found.revokedAt !== null) return null;
    return { ...found, scopes: [...found.scopes] };
  }

  async touchSession(
    id: string,
    lastSeenAt: number,
    expiresAt: number,
  ): Promise<void> {
    this.touchCalls.push({ id, lastSeenAt, expiresAt });
    const found = this.sessions.get(id);
    if (!found) return;
    this.sessions.set(id, { ...found, lastSeenAt, expiresAt });
  }

  async revokeSession(id: string, now: number): Promise<boolean> {
    this.revokeCalls.push({ id, now });
    const found = this.sessions.get(id);
    if (!found || found.revokedAt !== null) return false;
    this.sessions.set(id, { ...found, revokedAt: now });
    return true;
  }

  async revokeAllSessionsForIdentity(
    identityId: string,
    now: number,
    exceptSessionId?: string,
  ): Promise<number> {
    this.revokeAllCalls.push({ identityId, now, exceptSessionId });
    let count = 0;
    for (const row of this.sessions.values()) {
      if (row.identityId !== identityId) continue;
      if (row.revokedAt !== null) continue;
      if (exceptSessionId !== undefined && row.id === exceptSessionId) continue;
      this.sessions.set(row.id, { ...row, revokedAt: now });
      count += 1;
    }
    return count;
  }

  async appendAuditEvent(
    event: AppendAuditEventInput,
  ): Promise<AppendAuditEventInput> {
    this.auditEvents.push(event);
    return event;
  }
}

function asAuthStore(store: FakeAuthStore): AuthStore {
  return store as unknown as AuthStore;
}

function makeReq(
  headers: http.IncomingHttpHeaders,
): Pick<http.IncomingMessage, "headers"> {
  const req = new http.IncomingMessage(new Socket());
  req.headers = { ...headers };
  return req;
}

describe("session constants", () => {
  it("exports the documented TTLs and cookie/header names", () => {
    expect(BROWSER_SESSION_TTL_MS).toBe(12 * 60 * 60 * 1000);
    expect(BROWSER_SESSION_REMEMBER_CAP_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(MACHINE_SESSION_TTL_MS).toBe(90 * 24 * 60 * 60 * 1000);
    expect(SESSION_COOKIE_NAME).toBe("eliza_session");
    expect(CSRF_COOKIE_NAME).toBe("eliza_csrf");
    expect(CSRF_HEADER_NAME).toBe("x-eliza-csrf");
  });
});

describe("createBrowserSession", () => {
  it("mints a 12h browser session with a 256-bit id and derived CSRF token", async () => {
    const store = new FakeAuthStore();
    const { session, csrfToken } = await createBrowserSession(
      asAuthStore(store),
      {
        identityId: OWNER_ID,
        ip: "203.0.113.4",
        userAgent: "vitest-browser",
        rememberDevice: false,
        now: NOW,
      },
    );

    expect(session.id).toMatch(HEX64);
    expect(session.csrfSecret).toMatch(HEX64);
    expect(session.kind).toBe("browser");
    expect(session.identityId).toBe(OWNER_ID);
    expect(session.createdAt).toBe(NOW);
    expect(session.lastSeenAt).toBe(NOW);
    expect(session.expiresAt).toBe(NOW + BROWSER_SESSION_TTL_MS);
    expect(session.rememberDevice).toBe(false);
    expect(session.ip).toBe("203.0.113.4");
    expect(session.userAgent).toBe("vitest-browser");
    expect(session.scopes).toEqual([]);
    expect(session.revokedAt).toBeNull();
    expect(csrfToken).toBe(expectedCsrfToken(session));
    expect(store.createCalls).toHaveLength(1);
  });

  it("records rememberDevice without extending the initial 12h expiry", async () => {
    const store = new FakeAuthStore();
    const { session } = await createBrowserSession(asAuthStore(store), {
      identityId: OWNER_ID,
      ip: null,
      userAgent: null,
      rememberDevice: true,
      now: NOW,
    });

    expect(session.rememberDevice).toBe(true);
    expect(session.expiresAt).toBe(NOW + BROWSER_SESSION_TTL_MS);
    expect(session.expiresAt).not.toBe(NOW + BROWSER_SESSION_REMEMBER_CAP_MS);
  });

  it("stamps createdAt from Date.now when now is omitted", async () => {
    const store = new FakeAuthStore();
    const before = Date.now();
    const { session } = await createBrowserSession(asAuthStore(store), {
      identityId: OWNER_ID,
      ip: null,
      userAgent: null,
      rememberDevice: false,
    });
    const after = Date.now();

    expect(session.createdAt).toBeGreaterThanOrEqual(before);
    expect(session.createdAt).toBeLessThanOrEqual(after);
    expect(session.expiresAt).toBe(session.createdAt + BROWSER_SESSION_TTL_MS);
  });
});

describe("createMachineSession", () => {
  it("mints an absolute 90-day machine session and copies scopes", async () => {
    const store = new FakeAuthStore();
    const scopes = ["read", "write"];
    const { session, csrfToken } = await createMachineSession(
      asAuthStore(store),
      {
        identityId: OWNER_ID,
        scopes,
        label: "ci-runner",
        ip: "198.51.100.7",
        now: NOW,
      },
    );

    scopes.push("admin");
    expect(session.kind).toBe("machine");
    expect(session.rememberDevice).toBe(false);
    expect(session.expiresAt).toBe(NOW + MACHINE_SESSION_TTL_MS);
    expect(session.userAgent).toBe("ci-runner");
    expect(session.ip).toBe("198.51.100.7");
    expect(session.scopes).toEqual(["read", "write"]);
    expect(csrfToken).toBe(expectedCsrfToken(session));
  });

  it("defaults missing label and ip to null", async () => {
    const store = new FakeAuthStore();
    const { session } = await createMachineSession(asAuthStore(store), {
      identityId: OWNER_ID,
      scopes: [],
      now: NOW,
    });

    expect(session.ip).toBeNull();
    expect(session.userAgent).toBeNull();
    expect(session.scopes).toEqual([]);
  });
});

describe("denyOnAuthStoreError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs an Error and returns null", () => {
    const errorSpy = vi
      .spyOn(logger, "error")
      .mockImplementation(() => undefined as never);
    const error = new Error("auth db connection refused");

    expect(denyOnAuthStoreError("findActiveSession")(error)).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [context, message] = errorSpy.mock.calls[0] as [
      { scope?: string; error?: string; stack?: string },
      string,
    ];
    expect(context.scope).toBe("findActiveSession");
    expect(context.error).toBe("auth db connection refused");
    expect(context.stack).toEqual(expect.any(String));
    expect(message).toContain(
      "findActiveSession failed; failing closed (deny)",
    );
  });

  it("stringifies a non-Error rejection and omits stack", () => {
    const errorSpy = vi
      .spyOn(logger, "error")
      .mockImplementation(() => undefined as never);

    expect(denyOnAuthStoreError("findIdentity")("plain-string")).toBeNull();
    const [context] = errorSpy.mock.calls[0] as [
      { error?: string; stack?: string },
      string,
    ];
    expect(context.error).toBe("plain-string");
    expect(context.stack).toBeUndefined();
  });
});

describe("findActiveSession", () => {
  it("returns null when the store has no matching session", async () => {
    const store = new FakeAuthStore();
    await expect(
      findActiveSession(asAuthStore(store), "missing", NOW),
    ).resolves.toBeNull();
    expect(store.touchCalls).toEqual([]);
  });

  it("returns null for a revoked session the store already hides", async () => {
    const store = new FakeAuthStore().seed(sessionRow({ revokedAt: NOW - 1 }));
    await expect(
      findActiveSession(asAuthStore(store), "session-browser-1", NOW),
    ).resolves.toBeNull();
  });

  it("slides a browser session and persists lastSeenAt when the clock moved", async () => {
    const store = new FakeAuthStore().seed(sessionRow());
    const later = NOW + 1_000;
    const found = await findActiveSession(
      asAuthStore(store),
      "session-browser-1",
      later,
    );

    expect(found?.lastSeenAt).toBe(later);
    expect(found?.expiresAt).toBe(NOW + BROWSER_SESSION_TTL_MS);
    expect(store.touchCalls).toEqual([
      {
        id: "session-browser-1",
        lastSeenAt: later,
        expiresAt: NOW + BROWSER_SESSION_TTL_MS,
      },
    ]);
  });

  it("skips touch when lastSeenAt and expiry already match the proposed window", async () => {
    const store = new FakeAuthStore().seed(sessionRow());
    const found = await findActiveSession(
      asAuthStore(store),
      "session-browser-1",
      NOW,
    );

    expect(found).toEqual(sessionRow());
    expect(store.touchCalls).toEqual([]);
  });

  it("extends a short browser expiry up to the sliding cap and persists it", async () => {
    const store = new FakeAuthStore().seed(
      sessionRow({ expiresAt: NOW + 1_000 }),
    );
    const found = await findActiveSession(
      asAuthStore(store),
      "session-browser-1",
      NOW,
    );

    expect(found?.expiresAt).toBe(NOW + BROWSER_SESSION_TTL_MS);
    expect(store.touchCalls).toEqual([
      {
        id: "session-browser-1",
        lastSeenAt: NOW,
        expiresAt: NOW + BROWSER_SESSION_TTL_MS,
      },
    ]);
  });

  it("denies a browser session once now reaches the 12h createdAt cap", async () => {
    const store = new FakeAuthStore().seed(sessionRow());
    const atCap = NOW + BROWSER_SESSION_TTL_MS;
    await expect(
      findActiveSession(asAuthStore(store), "session-browser-1", atCap),
    ).resolves.toBeNull();
    expect(store.touchCalls).toEqual([]);
  });

  it("slides a remembered browser session past 12h up to the 30-day cap", async () => {
    const store = new FakeAuthStore().seed(
      sessionRow({
        rememberDevice: true,
        expiresAt: NOW + BROWSER_SESSION_TTL_MS,
      }),
    );
    const later = NOW + BROWSER_SESSION_TTL_MS + 60_000;
    const found = await findActiveSession(
      asAuthStore(store),
      "session-browser-1",
      later,
    );

    expect(found?.expiresAt).toBe(later + BROWSER_SESSION_TTL_MS);
    expect(found?.expiresAt).toBeLessThan(
      NOW + BROWSER_SESSION_REMEMBER_CAP_MS,
    );
    expect(store.touchCalls).toHaveLength(1);
  });

  it("clamps a remembered browser session to createdAt plus 30 days", async () => {
    const store = new FakeAuthStore().seed(
      sessionRow({
        rememberDevice: true,
        expiresAt: NOW + BROWSER_SESSION_REMEMBER_CAP_MS,
      }),
    );
    const nearCap = NOW + BROWSER_SESSION_REMEMBER_CAP_MS - 1;
    const found = await findActiveSession(
      asAuthStore(store),
      "session-browser-1",
      nearCap,
    );

    expect(found?.expiresAt).toBe(NOW + BROWSER_SESSION_REMEMBER_CAP_MS);
    expect(store.touchCalls).toEqual([
      {
        id: "session-browser-1",
        lastSeenAt: nearCap,
        expiresAt: NOW + BROWSER_SESSION_REMEMBER_CAP_MS,
      },
    ]);
  });

  it("denies a remembered browser session once now reaches the 30-day cap", async () => {
    const store = new FakeAuthStore().seed(
      sessionRow({
        rememberDevice: true,
        expiresAt: NOW + BROWSER_SESSION_REMEMBER_CAP_MS,
      }),
    );
    await expect(
      findActiveSession(
        asAuthStore(store),
        "session-browser-1",
        NOW + BROWSER_SESSION_REMEMBER_CAP_MS,
      ),
    ).resolves.toBeNull();
    expect(store.touchCalls).toEqual([]);
  });

  it("updates lastSeenAt on a machine session without extending expiry", async () => {
    const store = new FakeAuthStore().seed(
      sessionRow({
        id: "session-machine-1",
        kind: "machine",
        expiresAt: NOW + MACHINE_SESSION_TTL_MS,
      }),
    );
    const later = NOW + 5_000;
    const found = await findActiveSession(
      asAuthStore(store),
      "session-machine-1",
      later,
    );

    expect(found?.kind).toBe("machine");
    expect(found?.lastSeenAt).toBe(later);
    expect(found?.expiresAt).toBe(NOW + MACHINE_SESSION_TTL_MS);
    expect(store.touchCalls).toEqual([
      {
        id: "session-machine-1",
        lastSeenAt: later,
        expiresAt: NOW + MACHINE_SESSION_TTL_MS,
      },
    ]);
  });

  it("skips machine touch when lastSeenAt already equals now", async () => {
    const store = new FakeAuthStore().seed(
      sessionRow({
        id: "session-machine-1",
        kind: "machine",
        expiresAt: NOW + MACHINE_SESSION_TTL_MS,
      }),
    );
    const found = await findActiveSession(
      asAuthStore(store),
      "session-machine-1",
      NOW,
    );

    expect(found?.lastSeenAt).toBe(NOW);
    expect(store.touchCalls).toEqual([]);
  });

  it("returns an unrecognized kind unchanged and does not touch", async () => {
    const store = new FakeAuthStore().seed({
      ...sessionRow({ id: "session-legacy-1" }),
      kind: "legacy" as AuthSessionRow["kind"],
    });
    const found = await findActiveSession(
      asAuthStore(store),
      "session-legacy-1",
      NOW + 1_000,
    );

    expect(found?.id).toBe("session-legacy-1");
    expect(found?.lastSeenAt).toBe(NOW);
    expect(found?.expiresAt).toBe(NOW + BROWSER_SESSION_TTL_MS);
    expect(store.touchCalls).toEqual([]);
  });

  it("propagates a store read failure instead of collapsing it to null", async () => {
    const store = new FakeAuthStore();
    store.failFindSession = true;
    await expect(
      findActiveSession(asAuthStore(store), "session-browser-1", NOW),
    ).rejects.toThrow("session db down");
  });
});

describe("deriveCsrfToken and verifyCsrfToken", () => {
  const session = { id: "session-abc", csrfSecret: "secret-xyz" };

  it("HMACs csrf:<sessionId> with the per-session secret and is stable", () => {
    const token = deriveCsrfToken(session);
    expect(token).toBe(expectedCsrfToken(session));
    expect(deriveCsrfToken(session)).toBe(token);
    expect(
      deriveCsrfToken({ id: "other", csrfSecret: session.csrfSecret }),
    ).not.toBe(token);
    expect(
      deriveCsrfToken({ id: session.id, csrfSecret: "other-secret" }),
    ).not.toBe(token);
  });

  it("accepts the derived token and fails closed on empty, missing, or mismatched values", () => {
    const token = deriveCsrfToken(session);
    expect(verifyCsrfToken(session, token)).toBe(true);
    expect(verifyCsrfToken(session, `${token}x`)).toBe(false);
    expect(verifyCsrfToken(session, "")).toBe(false);
    expect(verifyCsrfToken(session, null)).toBe(false);
    expect(verifyCsrfToken(session, undefined)).toBe(false);
    expect(verifyCsrfToken(session, 123 as unknown as string)).toBe(false);
  });
});

describe("revokeSession", () => {
  let stateDir: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-sessions-test-"));
    previousStateDir = process.env.ELIZA_STATE_DIR;
    process.env.ELIZA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.ELIZA_STATE_DIR;
    } else {
      process.env.ELIZA_STATE_DIR = previousStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("revokes a live session, audits success, and returns true", async () => {
    const store = new FakeAuthStore().seed(sessionRow({ id: "sess-1" }));
    const ok = await revokeSession("sess-1", {
      store: asAuthStore(store),
      reason: "logout",
      actorIdentityId: OWNER_ID,
      ip: "203.0.113.9",
      userAgent: "vitest",
      now: NOW + 10,
    });

    expect(ok).toBe(true);
    expect(store.sessions.get("sess-1")?.revokedAt).toBe(NOW + 10);
    expect(store.revokeCalls).toEqual([{ id: "sess-1", now: NOW + 10 }]);
    expect(store.auditEvents).toHaveLength(1);
    expect(store.auditEvents[0]).toMatchObject({
      actorIdentityId: OWNER_ID,
      ip: "203.0.113.9",
      userAgent: "vitest",
      action: "auth.session.revoke",
      outcome: "success",
      metadata: { sessionId: "sess-1", reason: "logout" },
    });
  });

  it("audits failure and returns false when the session is missing", async () => {
    const store = new FakeAuthStore();
    const ok = await revokeSession("missing", {
      store: asAuthStore(store),
      reason: "logout",
      actorIdentityId: null,
      ip: null,
      userAgent: null,
      now: NOW,
    });

    expect(ok).toBe(false);
    expect(store.auditEvents[0]?.outcome).toBe("failure");
    expect(store.auditEvents[0]?.metadata).toEqual({
      sessionId: "missing",
      reason: "logout",
    });
  });
});

describe("revokeAllSessionsForIdentity", () => {
  let stateDir: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-sessions-test-"));
    previousStateDir = process.env.ELIZA_STATE_DIR;
    process.env.ELIZA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.ELIZA_STATE_DIR;
    } else {
      process.env.ELIZA_STATE_DIR = previousStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("revokes every session except the current one and audits the count", async () => {
    const store = new FakeAuthStore()
      .seed(sessionRow({ id: "keep" }))
      .seed(sessionRow({ id: "drop-a" }))
      .seed(sessionRow({ id: "drop-b" }))
      .seed(
        sessionRow({
          id: "other-owner",
          identityId: "identity-other",
        }),
      );

    const count = await revokeAllSessionsForIdentity({
      store: asAuthStore(store),
      identityId: OWNER_ID,
      exceptSessionId: "keep",
      reason: "rotate",
      ip: "192.0.2.1",
      userAgent: "vitest",
      now: NOW + 3,
    });

    expect(count).toBe(2);
    expect(store.sessions.get("keep")?.revokedAt).toBeNull();
    expect(store.sessions.get("drop-a")?.revokedAt).toBe(NOW + 3);
    expect(store.sessions.get("drop-b")?.revokedAt).toBe(NOW + 3);
    expect(store.sessions.get("other-owner")?.revokedAt).toBeNull();
    expect(store.revokeAllCalls).toEqual([
      {
        identityId: OWNER_ID,
        now: NOW + 3,
        exceptSessionId: "keep",
      },
    ]);
    expect(store.auditEvents[0]).toMatchObject({
      action: "auth.session.revoke_all",
      outcome: "success",
      metadata: { identityId: OWNER_ID, reason: "rotate", revoked: 2 },
    });
  });

  it("revokes every session when exceptSessionId is omitted, including a zero count", async () => {
    const empty = new FakeAuthStore();
    await expect(
      revokeAllSessionsForIdentity({
        store: asAuthStore(empty),
        identityId: OWNER_ID,
        reason: "none",
        ip: null,
        userAgent: null,
        now: NOW,
      }),
    ).resolves.toBe(0);
    expect(empty.revokeAllCalls[0]?.exceptSessionId).toBeUndefined();
    expect(empty.auditEvents[0]?.outcome).toBe("success");
    expect(empty.auditEvents[0]?.metadata).toMatchObject({ revoked: 0 });

    const store = new FakeAuthStore()
      .seed(sessionRow({ id: "a" }))
      .seed(sessionRow({ id: "b" }));
    await expect(
      revokeAllSessionsForIdentity({
        store: asAuthStore(store),
        identityId: OWNER_ID,
        reason: "lockout",
        ip: null,
        userAgent: null,
        now: NOW,
      }),
    ).resolves.toBe(2);
    expect(store.sessions.get("a")?.revokedAt).toBe(NOW);
    expect(store.sessions.get("b")?.revokedAt).toBe(NOW);
  });
});

describe("cookie serialize and parse", () => {
  it("serializes the session cookie without Secure on loopback and with Secure otherwise", () => {
    const session = { id: "abc def", expiresAt: NOW };
    expect(
      serializeSessionCookie(session, { env: LOOPBACK_ENV, maxAgeMs: 65_000 }),
    ).toBe(
      "eliza_session=abc%20def; Path=/; HttpOnly; SameSite=Lax; Max-Age=65",
    );
    expect(
      serializeSessionCookie(session, { env: PUBLIC_ENV, maxAgeMs: 65_000 }),
    ).toBe(
      "eliza_session=abc%20def; Path=/; HttpOnly; SameSite=Lax; Max-Age=65; Secure",
    );
  });

  it("floors Max-Age to zero when the session is already expired", () => {
    const header = serializeSessionCookie(
      { id: "abc", expiresAt: Date.now() - 5_000 },
      { env: LOOPBACK_ENV },
    );
    expect(header).toBe(
      "eliza_session=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    );
  });

  it("serializes a readable CSRF cookie with the derived token and no HttpOnly", () => {
    const session = sessionRow({ id: "csrf-sess", csrfSecret: "k" });
    const token = expectedCsrfToken(session);
    expect(
      serializeCsrfCookie(session, { env: LOOPBACK_ENV, maxAgeMs: 2_000 }),
    ).toBe(
      `eliza_csrf=${encodeURIComponent(token)}; Path=/; SameSite=Lax; Max-Age=2`,
    );
    expect(
      serializeCsrfCookie(session, { env: PUBLIC_ENV, maxAgeMs: 2_000 }),
    ).toContain("; Secure");
    expect(
      serializeCsrfCookie(session, { env: PUBLIC_ENV, maxAgeMs: 2_000 }),
    ).not.toContain("HttpOnly");
  });

  it("builds expiry cookies that clear the client with Max-Age=0", () => {
    expect(serializeSessionExpiryCookie({ env: LOOPBACK_ENV })).toBe(
      "eliza_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    );
    expect(serializeSessionExpiryCookie({ env: PUBLIC_ENV })).toContain(
      "; Secure",
    );
    expect(serializeCsrfExpiryCookie({ env: LOOPBACK_ENV })).toBe(
      "eliza_csrf=; Path=/; SameSite=Lax; Max-Age=0",
    );
    expect(serializeCsrfExpiryCookie({ env: PUBLIC_ENV })).toBe(
      "eliza_csrf=; Path=/; SameSite=Lax; Max-Age=0; Secure",
    );
  });

  it("parses Cookie headers, dropping invalid pairs and decoding values", () => {
    expect(parseCookieHeader(null).size).toBe(0);
    expect(parseCookieHeader("").size).toBe(0);

    const cookies = parseCookieHeader(
      "noequals; =nokey; empty=; eliza_session=abc%20def; dup=1; dup=2; bad=%ZZ; spaced = value ",
    );
    expect(cookies.get("eliza_session")).toBe("abc def");
    expect(cookies.get("dup")).toBe("2");
    expect(cookies.get("bad")).toBe("%ZZ");
    expect(cookies.get("spaced")).toBe("value");
    expect(cookies.has("noequals")).toBe(false);
    expect(cookies.has("")).toBe(false);
    expect(cookies.has("empty")).toBe(false);
  });

  it("reads the eliza session cookie and returns null when it is absent or empty", () => {
    expect(parseSessionCookie(makeReq({}))).toBeNull();
    expect(parseSessionCookie(makeReq({ cookie: "other=value" }))).toBeNull();
    expect(
      parseSessionCookie(makeReq({ cookie: "eliza_session=" })),
    ).toBeNull();
    expect(
      parseSessionCookie(makeReq({ cookie: "eliza_session=live-id" })),
    ).toBe("live-id");

    const arrayReq = new http.IncomingMessage(new Socket());
    (arrayReq.headers as Record<string, string | string[]>).cookie = [
      "eliza_session=from-array",
      "eliza_session=second",
    ];
    expect(parseSessionCookie(arrayReq)).toBe("from-array");
  });
});
