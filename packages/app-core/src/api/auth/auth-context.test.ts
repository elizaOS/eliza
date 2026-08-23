/**
 * Tests `ensureSessionForRequest`, the fail-closed request guard that resolves
 * a cookie session, then a session-id bearer, then an unauthenticated bootstrap
 * bearer. Drives the real helper against hand-built Node `IncomingMessage`
 * objects and an in-memory `AuthStore` collaborator — no live server, no
 * mocked `parseSessionCookie` / `findActiveSession` / `getProvidedApiToken`.
 */
import http from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import type {
  AuthIdentityRow,
  AuthSessionRow,
  AuthStore,
} from "../../services/auth-store";
import { ensureSessionForRequest } from "./auth-context";
import {
  BROWSER_SESSION_REMEMBER_CAP_MS,
  BROWSER_SESSION_TTL_MS,
  MACHINE_SESSION_TTL_MS,
  SESSION_COOKIE_NAME,
} from "./sessions";

const NOW = 1_700_000_000_000;
const OWNER_ID = "identity-owner-1";
const SESSION_ID = "session-browser-1";
const MACHINE_SESSION_ID = "session-machine-1";
const BEARER_SESSION_ID = "session-bearer-1";
const BOOTSTRAP_TOKEN = "bootstrap-token-not-a-session";

function identity(overrides: Partial<AuthIdentityRow> = {}): AuthIdentityRow {
  return {
    id: OWNER_ID,
    kind: "owner",
    displayName: "Owner",
    createdAt: NOW,
    passwordHash: null,
    cloudUserId: null,
    ...overrides,
  };
}

function session(overrides: Partial<AuthSessionRow> = {}): AuthSessionRow {
  return {
    id: SESSION_ID,
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
  public readonly identities = new Map<string, AuthIdentityRow>();
  public readonly sessions = new Map<string, AuthSessionRow>();
  public readonly findSessionCalls: Array<{ id: string; now: number }> = [];
  public readonly findIdentityCalls: string[] = [];
  public readonly touchCalls: Array<{
    id: string;
    lastSeenAt: number;
    expiresAt: number;
  }> = [];
  public failFindSessionFor: string | null = null;
  public failFindIdentity = false;
  public failTouchFor: string | null = null;

  seed(row: AuthSessionRow, owner: AuthIdentityRow = identity()): this {
    this.sessions.set(row.id, { ...row, scopes: [...row.scopes] });
    this.identities.set(owner.id, { ...owner });
    return this;
  }

  async findSession(
    id: string,
    now: number = Date.now(),
  ): Promise<AuthSessionRow | null> {
    this.findSessionCalls.push({ id, now });
    if (this.failFindSessionFor === id) {
      throw new Error(`session db down for ${id}`);
    }
    const found = this.sessions.get(id);
    if (!found) return null;
    if (found.revokedAt !== null) return null;
    if (found.expiresAt <= now) return null;
    return { ...found, scopes: [...found.scopes] };
  }

  async findIdentity(id: string): Promise<AuthIdentityRow | null> {
    this.findIdentityCalls.push(id);
    if (this.failFindIdentity) throw new Error("identity db down");
    const found = this.identities.get(id);
    return found ? { ...found } : null;
  }

  async touchSession(
    id: string,
    lastSeenAt: number,
    expiresAt: number,
  ): Promise<void> {
    this.touchCalls.push({ id, lastSeenAt, expiresAt });
    if (this.failTouchFor === id) throw new Error(`touch failed for ${id}`);
    const found = this.sessions.get(id);
    if (!found) return;
    this.sessions.set(id, { ...found, lastSeenAt, expiresAt });
  }
}

function asAuthStore(store: FakeAuthStore): AuthStore {
  return store as unknown as AuthStore;
}

function makeReq(headers: http.IncomingHttpHeaders): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.headers = { ...headers };
  return req;
}

function fakeRes(): http.ServerResponse {
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.setHeader = () => res;
  res.end = (() => res) as typeof res.end;
  return res;
}

function cookieHeader(sessionId: string): http.IncomingHttpHeaders {
  return { cookie: `${SESSION_COOKIE_NAME}=${sessionId}` };
}

function bearerHeader(token: string): http.IncomingHttpHeaders {
  return { authorization: `Bearer ${token}` };
}

describe("ensureSessionForRequest", () => {
  it("returns a cookie-sourced context when the cookie session and identity both resolve", async () => {
    const store = new FakeAuthStore().seed(session());
    const ctx = await ensureSessionForRequest(
      makeReq(cookieHeader(SESSION_ID)),
      fakeRes(),
      { store: asAuthStore(store), now: NOW },
    );

    expect(ctx).toEqual({
      session: session(),
      identity: identity(),
      source: "cookie",
    });
    expect(store.findSessionCalls).toEqual([{ id: SESSION_ID, now: NOW }]);
    expect(store.findIdentityCalls).toEqual([OWNER_ID]);
  });

  it("prefers a valid cookie over a simultaneously presented valid bearer", async () => {
    const store = new FakeAuthStore()
      .seed(session())
      .seed(session({ id: BEARER_SESSION_ID }));

    const ctx = await ensureSessionForRequest(
      makeReq({
        ...cookieHeader(SESSION_ID),
        ...bearerHeader(BEARER_SESSION_ID),
      }),
      fakeRes(),
      { store: asAuthStore(store), now: NOW },
    );

    expect(ctx?.source).toBe("cookie");
    expect(ctx?.session?.id).toBe(SESSION_ID);
    expect(store.findSessionCalls.map((call) => call.id)).toEqual([SESSION_ID]);
  });

  it("returns null when the cookie session resolves but the identity is missing, without falling through to bearer", async () => {
    const store = new FakeAuthStore().seed(
      session({ identityId: "missing-identity" }),
    );

    const ctx = await ensureSessionForRequest(
      makeReq({
        ...cookieHeader(SESSION_ID),
        ...bearerHeader(BEARER_SESSION_ID),
      }),
      fakeRes(),
      { store: asAuthStore(store), now: NOW },
    );

    expect(ctx).toBeNull();
    expect(store.findSessionCalls.map((call) => call.id)).toEqual([SESSION_ID]);
    expect(store.findIdentityCalls).toEqual(["missing-identity"]);
  });

  it("returns null when the cookie identity lookup throws (fail closed, no bearer fallthrough)", async () => {
    const store = new FakeAuthStore()
      .seed(session())
      .seed(session({ id: BEARER_SESSION_ID }));
    store.failFindIdentity = true;

    const ctx = await ensureSessionForRequest(
      makeReq({
        ...cookieHeader(SESSION_ID),
        ...bearerHeader(BEARER_SESSION_ID),
      }),
      fakeRes(),
      { store: asAuthStore(store), now: NOW },
    );

    expect(ctx).toBeNull();
  });

  it("falls through from an unknown cookie to a valid bearer session", async () => {
    const store = new FakeAuthStore().seed(session({ id: BEARER_SESSION_ID }));

    const ctx = await ensureSessionForRequest(
      makeReq({
        ...cookieHeader("stale-cookie-session"),
        ...bearerHeader(BEARER_SESSION_ID),
      }),
      fakeRes(),
      { store: asAuthStore(store), now: NOW },
    );

    expect(ctx?.source).toBe("bearer-session");
    expect(ctx?.session?.id).toBe(BEARER_SESSION_ID);
    expect(ctx?.identity).toEqual(identity());
    expect(store.findSessionCalls.map((call) => call.id)).toEqual([
      "stale-cookie-session",
      BEARER_SESSION_ID,
    ]);
  });

  it("falls through from an expired cookie session to a valid bearer session", async () => {
    const store = new FakeAuthStore()
      .seed(session({ expiresAt: NOW }))
      .seed(session({ id: BEARER_SESSION_ID }));

    const ctx = await ensureSessionForRequest(
      makeReq({
        ...cookieHeader(SESSION_ID),
        ...bearerHeader(BEARER_SESSION_ID),
      }),
      fakeRes(),
      { store: asAuthStore(store), now: NOW },
    );

    expect(ctx?.source).toBe("bearer-session");
    expect(ctx?.session?.id).toBe(BEARER_SESSION_ID);
  });

  it("falls through from a revoked cookie session to a valid bearer session", async () => {
    const store = new FakeAuthStore()
      .seed(session({ revokedAt: NOW - 1 }))
      .seed(session({ id: BEARER_SESSION_ID }));

    const ctx = await ensureSessionForRequest(
      makeReq({
        ...cookieHeader(SESSION_ID),
        ...bearerHeader(BEARER_SESSION_ID),
      }),
      fakeRes(),
      { store: asAuthStore(store), now: NOW },
    );

    expect(ctx?.source).toBe("bearer-session");
    expect(ctx?.session?.id).toBe(BEARER_SESSION_ID);
  });

  it("falls through from a cookie session-store throw to a valid bearer session", async () => {
    const store = new FakeAuthStore().seed(session({ id: BEARER_SESSION_ID }));
    store.failFindSessionFor = SESSION_ID;

    const ctx = await ensureSessionForRequest(
      makeReq({
        ...cookieHeader(SESSION_ID),
        ...bearerHeader(BEARER_SESSION_ID),
      }),
      fakeRes(),
      { store: asAuthStore(store), now: NOW },
    );

    expect(ctx?.source).toBe("bearer-session");
    expect(ctx?.session?.id).toBe(BEARER_SESSION_ID);
  });

  it("falls through when cookie findActiveSession rejects because touchSession throws", async () => {
    const later = NOW + 1_000;
    const store = new FakeAuthStore().seed(session()).seed(
      session({
        id: BEARER_SESSION_ID,
        lastSeenAt: later,
      }),
    );
    store.failTouchFor = SESSION_ID;

    const ctx = await ensureSessionForRequest(
      makeReq({
        ...cookieHeader(SESSION_ID),
        ...bearerHeader(BEARER_SESSION_ID),
      }),
      fakeRes(),
      { store: asAuthStore(store), now: later },
    );

    expect(ctx?.source).toBe("bearer-session");
    expect(ctx?.session?.id).toBe(BEARER_SESSION_ID);
  });

  it("returns null when a cookie is present but invalid and no bearer is supplied", async () => {
    const store = new FakeAuthStore();
    const ctx = await ensureSessionForRequest(
      makeReq(cookieHeader("not-in-store")),
      fakeRes(),
      { store: asAuthStore(store), now: NOW },
    );
    expect(ctx).toBeNull();
  });

  it("treats an empty eliza_session cookie value as absent", async () => {
    const store = new FakeAuthStore().seed(session());
    const ctx = await ensureSessionForRequest(
      makeReq({ cookie: `${SESSION_COOKIE_NAME}=` }),
      fakeRes(),
      { store: asAuthStore(store), now: NOW },
    );
    expect(ctx).toBeNull();
    expect(store.findSessionCalls).toEqual([]);
  });

  it("returns a bearer-session context when Authorization maps to a live session", async () => {
    const store = new FakeAuthStore().seed(session({ id: BEARER_SESSION_ID }));
    const ctx = await ensureSessionForRequest(
      makeReq(bearerHeader(BEARER_SESSION_ID)),
      fakeRes(),
      { store: asAuthStore(store), now: NOW },
    );
    expect(ctx).toEqual({
      session: session({ id: BEARER_SESSION_ID }),
      identity: identity(),
      source: "bearer-session",
    });
  });

  it("accepts x-eliza-token as the bearer when Authorization is absent", async () => {
    const store = new FakeAuthStore().seed(session({ id: BEARER_SESSION_ID }));
    const ctx = await ensureSessionForRequest(
      makeReq({ "x-eliza-token": BEARER_SESSION_ID }),
      fakeRes(),
      { store: asAuthStore(store), now: NOW },
    );
    expect(ctx?.source).toBe("bearer-session");
    expect(ctx?.session?.id).toBe(BEARER_SESSION_ID);
  });

  it("returns null when the bearer session resolves but the identity is missing", async () => {
    const store = new FakeAuthStore().seed(
      session({ id: BEARER_SESSION_ID, identityId: "gone" }),
    );

    const ctx = await ensureSessionForRequest(
      makeReq(bearerHeader(BEARER_SESSION_ID)),
      fakeRes(),
      { store: asAuthStore(store), now: NOW },
    );
    expect(ctx).toBeNull();
  });

  it("returns null when the bearer identity lookup throws", async () => {
    const store = new FakeAuthStore().seed(session({ id: BEARER_SESSION_ID }));
    store.failFindIdentity = true;

    const ctx = await ensureSessionForRequest(
      makeReq(bearerHeader(BEARER_SESSION_ID)),
      fakeRes(),
      { store: asAuthStore(store), now: NOW },
    );
    expect(ctx).toBeNull();
  });

  it("returns bearer-bootstrap for an unknown bearer when allowBootstrapBearer defaults to true", async () => {
    const store = new FakeAuthStore();
    const ctx = await ensureSessionForRequest(
      makeReq(bearerHeader(BOOTSTRAP_TOKEN)),
      fakeRes(),
      { store: asAuthStore(store), now: NOW },
    );
    expect(ctx).toEqual({
      session: null,
      identity: null,
      source: "bearer-bootstrap",
    });
  });

  it("returns bearer-bootstrap for an unknown bearer when allowBootstrapBearer is explicitly true", async () => {
    const store = new FakeAuthStore();
    const ctx = await ensureSessionForRequest(
      makeReq(bearerHeader(BOOTSTRAP_TOKEN)),
      fakeRes(),
      {
        store: asAuthStore(store),
        now: NOW,
        allowBootstrapBearer: true,
      },
    );
    expect(ctx?.source).toBe("bearer-bootstrap");
    expect(ctx?.session).toBeNull();
    expect(ctx?.identity).toBeNull();
  });

  it("returns null for an unknown bearer when allowBootstrapBearer is false", async () => {
    const store = new FakeAuthStore();
    const ctx = await ensureSessionForRequest(
      makeReq(bearerHeader(BOOTSTRAP_TOKEN)),
      fakeRes(),
      {
        store: asAuthStore(store),
        now: NOW,
        allowBootstrapBearer: false,
      },
    );
    expect(ctx).toBeNull();
  });

  it("returns bearer-bootstrap when bearer session lookup throws and bootstrap is allowed", async () => {
    const store = new FakeAuthStore();
    store.failFindSessionFor = BOOTSTRAP_TOKEN;

    const ctx = await ensureSessionForRequest(
      makeReq(bearerHeader(BOOTSTRAP_TOKEN)),
      fakeRes(),
      { store: asAuthStore(store), now: NOW },
    );
    expect(ctx).toEqual({
      session: null,
      identity: null,
      source: "bearer-bootstrap",
    });
  });

  it("returns null when bearer session lookup throws and bootstrap is disallowed", async () => {
    const store = new FakeAuthStore();
    store.failFindSessionFor = BOOTSTRAP_TOKEN;

    const ctx = await ensureSessionForRequest(
      makeReq(bearerHeader(BOOTSTRAP_TOKEN)),
      fakeRes(),
      {
        store: asAuthStore(store),
        now: NOW,
        allowBootstrapBearer: false,
      },
    );
    expect(ctx).toBeNull();
  });

  it("falls through from a stale cookie to bearer-bootstrap when the bearer is not a session", async () => {
    const store = new FakeAuthStore();
    const ctx = await ensureSessionForRequest(
      makeReq({
        ...cookieHeader("stale-cookie-session"),
        ...bearerHeader(BOOTSTRAP_TOKEN),
      }),
      fakeRes(),
      { store: asAuthStore(store), now: NOW },
    );
    expect(ctx?.source).toBe("bearer-bootstrap");
  });

  it("returns null when the request has neither a session cookie nor a bearer", async () => {
    const store = new FakeAuthStore().seed(session());
    const ctx = await ensureSessionForRequest(makeReq({}), fakeRes(), {
      store: asAuthStore(store),
      now: NOW,
    });
    expect(ctx).toBeNull();
    expect(store.findSessionCalls).toEqual([]);
  });

  it("slides lastSeenAt on a browser cookie session when now advances", async () => {
    const later = NOW + 5_000;
    const store = new FakeAuthStore().seed(session());

    const ctx = await ensureSessionForRequest(
      makeReq(cookieHeader(SESSION_ID)),
      fakeRes(),
      { store: asAuthStore(store), now: later },
    );

    expect(ctx?.source).toBe("cookie");
    expect(ctx?.session?.lastSeenAt).toBe(later);
    expect(ctx?.session?.expiresAt).toBe(NOW + BROWSER_SESSION_TTL_MS);
    expect(store.touchCalls).toEqual([
      {
        id: SESSION_ID,
        lastSeenAt: later,
        expiresAt: NOW + BROWSER_SESSION_TTL_MS,
      },
    ]);
  });

  it("extends expiresAt on a rememberDevice browser session within the 30-day cap", async () => {
    const later = NOW + 60_000;
    const store = new FakeAuthStore().seed(
      session({
        rememberDevice: true,
        expiresAt: NOW + BROWSER_SESSION_TTL_MS,
      }),
    );

    const ctx = await ensureSessionForRequest(
      makeReq(cookieHeader(SESSION_ID)),
      fakeRes(),
      { store: asAuthStore(store), now: later },
    );

    expect(ctx?.session?.lastSeenAt).toBe(later);
    expect(ctx?.session?.expiresAt).toBe(later + BROWSER_SESSION_TTL_MS);
    expect(ctx?.session?.expiresAt).toBeLessThan(
      NOW + BROWSER_SESSION_REMEMBER_CAP_MS,
    );
  });

  it("updates lastSeenAt on a machine bearer session without extending expiresAt", async () => {
    const later = NOW + 10_000;
    const expiresAt = NOW + MACHINE_SESSION_TTL_MS;
    const store = new FakeAuthStore().seed(
      session({
        id: MACHINE_SESSION_ID,
        kind: "machine",
        expiresAt,
        rememberDevice: false,
      }),
    );

    const ctx = await ensureSessionForRequest(
      makeReq(bearerHeader(MACHINE_SESSION_ID)),
      fakeRes(),
      { store: asAuthStore(store), now: later },
    );

    expect(ctx?.source).toBe("bearer-session");
    expect(ctx?.session?.kind).toBe("machine");
    expect(ctx?.session?.lastSeenAt).toBe(later);
    expect(ctx?.session?.expiresAt).toBe(expiresAt);
    expect(store.touchCalls).toEqual([
      { id: MACHINE_SESSION_ID, lastSeenAt: later, expiresAt },
    ]);
  });

  it("does not authenticate a browser cookie whose absolute cap has already passed, and falls through to bearer", async () => {
    const capNow = NOW + BROWSER_SESSION_TTL_MS;
    const store = new FakeAuthStore()
      .seed(
        session({
          createdAt: NOW,
          lastSeenAt: NOW,
          rememberDevice: false,
          expiresAt: capNow + 1,
        }),
      )
      .seed(
        session({
          id: BEARER_SESSION_ID,
          createdAt: capNow,
          lastSeenAt: capNow,
          expiresAt: capNow + BROWSER_SESSION_TTL_MS,
        }),
      );

    const ctx = await ensureSessionForRequest(
      makeReq({
        ...cookieHeader(SESSION_ID),
        ...bearerHeader(BEARER_SESSION_ID),
      }),
      fakeRes(),
      { store: asAuthStore(store), now: capNow },
    );

    expect(ctx?.source).toBe("bearer-session");
    expect(ctx?.session?.id).toBe(BEARER_SESSION_ID);
  });

  it("authenticates with the default clock when now is omitted and the session is still live", async () => {
    const now = Date.now();
    const store = new FakeAuthStore().seed(
      session({
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + BROWSER_SESSION_TTL_MS,
      }),
    );

    const ctx = await ensureSessionForRequest(
      makeReq(cookieHeader(SESSION_ID)),
      fakeRes(),
      { store: asAuthStore(store) },
    );

    expect(ctx?.source).toBe("cookie");
    expect(ctx?.session?.id).toBe(SESSION_ID);
    expect(ctx?.identity?.id).toBe(OWNER_ID);
  });
});
