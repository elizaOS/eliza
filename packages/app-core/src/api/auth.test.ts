/**
 * Unit tests for the app-core HTTP auth helpers in `auth.ts`: cookie and token
 * extraction, the failed-attempt rate limiter (empty / single / overflow),
 * sync and async route gates, and identity/embed role mapping. Drives the
 * real module through Node `http.IncomingMessage` / `ServerResponse` objects
 * and an in-memory AuthStore collaborator — no mocks of the system under test.
 */

import http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthSessionRow, AuthStore } from "../services/auth-store";
import { mintEmbedSessionToken } from "./auth/embed-session-token.js";
import { CSRF_HEADER_NAME, deriveCsrfToken } from "./auth/sessions.js";
import {
  _resetAuthRateLimiter,
  embedBoundaryRole,
  ensureAuthSessionOrBootstrap,
  ensureCompatApiAuthorized,
  ensureCompatApiAuthorizedAsync,
  ensureCompatSensitiveRouteAuthorized,
  ensureRouteAuthorized,
  ensureRouteMinRole,
  extractHeaderValue,
  getCompatApiToken,
  getProvidedApiToken,
  getSessionCookieName,
  isDevEnvironment,
  readCookie,
  resolveAuthorizedRouteRole,
  resolveEmbedPrincipal,
  roleForIdentityKind,
  tokenMatches,
} from "./auth.js";

const ENV_KEYS = [
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_DEV_AUTH_BYPASS",
  "ELIZA_CLOUD_PROVISIONED",
  "STEWARD_AGENT_TOKEN",
  "ELIZA_API_TOKEN",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZA_EMBED_SESSION_SECRET",
  "NODE_ENV",
] as const;

const BOOT_CONFIG_STORE_KEY = Symbol.for("elizaos.app.boot-config");
const EMBED_SECRET = "embed-secret-at-least-16-chars-long";
const EMBED_ENTITY = "11111111-1111-1111-1111-111111111111";
const EMBED_NOW = 1_700_000_000_000;
const AUTH_RATE_LIMIT_MAX = 20;
const TOKEN = "compat-api-token-value";

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> =
  {};

function snapshotEnv(): void {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
}

function restoreEnv(): void {
  Reflect.deleteProperty(globalThis, BOOT_CONFIG_STORE_KEY);
  for (const key of ENV_KEYS) {
    const prior = savedEnv[key];
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
}

function clearAuthEnv(): void {
  Reflect.deleteProperty(globalThis, BOOT_CONFIG_STORE_KEY);
  for (const key of ENV_KEYS) {
    if (key === "NODE_ENV") continue;
    delete process.env[key];
  }
}

function makeReq(options: {
  method?: string;
  headers?: http.IncomingHttpHeaders;
  remoteAddress?: string | null;
}): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = options.method ?? "GET";
  req.headers = {
    host: "example.test:2138",
    ...(options.headers ?? {}),
  };
  Object.defineProperty(req.socket, "remoteAddress", {
    value:
      options.remoteAddress === undefined
        ? "203.0.113.9"
        : options.remoteAddress,
    configurable: true,
  });
  return req;
}

function loopbackReq(
  headers: http.IncomingHttpHeaders = {},
): http.IncomingMessage {
  return makeReq({
    headers: { host: "localhost:2138", ...headers },
    remoteAddress: "127.0.0.1",
  });
}

function remoteReq(
  options: {
    method?: string;
    headers?: http.IncomingHttpHeaders;
    remoteAddress?: string | null;
  } = {},
): http.IncomingMessage {
  return makeReq({
    method: options.method,
    headers: {
      "x-forwarded-for": "203.0.113.9",
      ...(options.headers ?? {}),
    },
    remoteAddress:
      options.remoteAddress === undefined
        ? "203.0.113.9"
        : options.remoteAddress,
  });
}

function fakeRes(): {
  res: http.ServerResponse;
  status(): number;
  json(): unknown;
} {
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

function sessionRow(
  overrides: Partial<AuthSessionRow> &
    Pick<AuthSessionRow, "id" | "identityId">,
): AuthSessionRow {
  const now = EMBED_NOW;
  return {
    kind: "browser",
    createdAt: now - 1_000,
    lastSeenAt: now - 1_000,
    expiresAt: now + 60_000,
    rememberDevice: false,
    csrfSecret: "csrf-secret-value",
    ip: null,
    userAgent: null,
    scopes: [],
    revokedAt: null,
    ...overrides,
  };
}

function memoryStore(options: {
  sessions?: Record<string, AuthSessionRow>;
  identities?: Record<string, { id: string; kind: string }>;
}): AuthStore {
  const sessions = { ...(options.sessions ?? {}) };
  const identities = { ...(options.identities ?? {}) };
  return {
    findSession: async (id: string) => sessions[id] ?? null,
    findIdentity: async (id: string) => identities[id] ?? null,
    touchSession: async () => undefined,
  } as unknown as AuthStore;
}

beforeEach(() => {
  snapshotEnv();
  clearAuthEnv();
  _resetAuthRateLimiter();
});

afterEach(() => {
  _resetAuthRateLimiter();
  restoreEnv();
});

describe("getSessionCookieName", () => {
  it("returns the eliza_session cookie name", () => {
    expect(getSessionCookieName()).toBe("eliza_session");
  });
});

describe("isDevEnvironment", () => {
  it("is true for development and dev after trim and case fold", () => {
    process.env.NODE_ENV = "development";
    expect(isDevEnvironment()).toBe(true);
    process.env.NODE_ENV = "  DEV  ";
    expect(isDevEnvironment()).toBe(true);
  });

  it("is false for production, test, empty, and unset NODE_ENV", () => {
    process.env.NODE_ENV = "production";
    expect(isDevEnvironment()).toBe(false);
    process.env.NODE_ENV = "test";
    expect(isDevEnvironment()).toBe(false);
    process.env.NODE_ENV = "   ";
    expect(isDevEnvironment()).toBe(false);
    delete process.env.NODE_ENV;
    expect(isDevEnvironment()).toBe(false);
  });
});

describe("getCompatApiToken", () => {
  it("returns null when no API token is configured", () => {
    expect(getCompatApiToken()).toBeNull();
  });

  it("returns the configured ELIZA_API_TOKEN", () => {
    process.env.ELIZA_API_TOKEN = TOKEN;
    expect(getCompatApiToken()).toBe(TOKEN);
  });

  it("strips a Bearer prefix from the configured token", () => {
    process.env.ELIZA_API_TOKEN = `Bearer ${TOKEN}`;
    expect(getCompatApiToken()).toBe(TOKEN);
  });
});

describe("readCookie", () => {
  it("returns null when the cookie header is missing or empty", () => {
    expect(readCookie({ headers: {} }, "eliza_session")).toBeNull();
    expect(readCookie({ headers: { cookie: "" } }, "eliza_session")).toBeNull();
  });

  it("skips cookie parts without an equals sign", () => {
    expect(
      readCookie(
        { headers: { cookie: "flags; eliza_session=abc" } },
        "eliza_session",
      ),
    ).toBe("abc");
  });

  it("returns null for an empty named cookie value", () => {
    expect(
      readCookie({ headers: { cookie: "eliza_session=" } }, "eliza_session"),
    ).toBeNull();
    expect(
      readCookie({ headers: { cookie: "eliza_session=   " } }, "eliza_session"),
    ).toBeNull();
  });

  it("returns the first matching cookie when the name is repeated", () => {
    expect(
      readCookie(
        { headers: { cookie: "eliza_session=first; eliza_session=second" } },
        "eliza_session",
      ),
    ).toBe("first");
  });

  it("finds the named cookie among siblings", () => {
    expect(
      readCookie(
        { headers: { cookie: "a=1; eliza_session=sid; b=2" } },
        "eliza_session",
      ),
    ).toBe("sid");
  });

  it("returns null when the named cookie is absent", () => {
    expect(
      readCookie({ headers: { cookie: "other=1" } }, "eliza_session"),
    ).toBeNull();
  });

  it("decodes a percent-encoded value and treats malformed encoding as absent", () => {
    expect(
      readCookie(
        { headers: { cookie: "eliza_session=hello%20world" } },
        "eliza_session",
      ),
    ).toBe("hello world");
    expect(
      readCookie({ headers: { cookie: "eliza_session=%ZZ" } }, "eliza_session"),
    ).toBeNull();
  });

  it("reads the first value when the cookie header is an array", () => {
    expect(
      readCookie(
        {
          headers: {
            cookie: ["eliza_session=from-array", "eliza_session=later"],
          } as unknown as http.IncomingHttpHeaders,
        },
        "eliza_session",
      ),
    ).toBe("from-array");
  });
});

describe("token header helpers re-exported from auth.ts", () => {
  it("extractHeaderValue prefers a string, then the first array entry", () => {
    expect(extractHeaderValue("abc")).toBe("abc");
    expect(extractHeaderValue(["first", "second"])).toBe("first");
    expect(extractHeaderValue(undefined)).toBeNull();
    expect(extractHeaderValue([])).toBeNull();
  });

  it("tokenMatches is true only for equal utf8 bytes", () => {
    expect(tokenMatches("secret", "secret")).toBe(true);
    expect(tokenMatches("secret", "Secret")).toBe(false);
    expect(tokenMatches("secret", "secre")).toBe(false);
    expect(tokenMatches("", "")).toBe(true);
  });

  it("getProvidedApiToken prefers Authorization Bearer over x-eliza-token", () => {
    const req = remoteReq({
      headers: {
        authorization: "Bearer from-auth",
        "x-eliza-token": "from-header",
      },
    });
    expect(getProvidedApiToken(req)).toBe("from-auth");
  });

  it("getProvidedApiToken falls through non-Bearer Authorization to x-eliza-token", () => {
    const req = remoteReq({
      headers: {
        authorization: "Basic abc",
        "x-eliza-token": "from-header",
      },
    });
    expect(getProvidedApiToken(req)).toBe("from-header");
  });

  it("getProvidedApiToken reads x-api-key when no other token header is set", () => {
    expect(
      getProvidedApiToken(remoteReq({ headers: { "x-api-key": "key-token" } })),
    ).toBe("key-token");
  });
});

describe("roleForIdentityKind", () => {
  it("maps owner to OWNER, machine to USER, and everything else to NONE", () => {
    expect(roleForIdentityKind("owner")).toBe("OWNER");
    expect(roleForIdentityKind("machine")).toBe("USER");
    expect(roleForIdentityKind(null)).toBe("NONE");
    expect(roleForIdentityKind(undefined)).toBe("NONE");
    expect(roleForIdentityKind("guest" as never)).toBe("NONE");
  });
});

describe("embedBoundaryRole", () => {
  it("maps OWNER to OWNER, ADMIN to USER, and null to null", () => {
    expect(
      embedBoundaryRole({
        entityId: EMBED_ENTITY,
        role: "OWNER",
        adminMode: true,
        exp: EMBED_NOW,
      }),
    ).toBe("OWNER");
    expect(
      embedBoundaryRole({
        entityId: EMBED_ENTITY,
        role: "ADMIN",
        adminMode: false,
        exp: EMBED_NOW,
      }),
    ).toBe("USER");
    expect(embedBoundaryRole(null)).toBeNull();
  });
});

describe("resolveEmbedPrincipal", () => {
  it("returns null when the secret or bearer is missing", () => {
    const token = mintEmbedSessionToken(
      {
        entityId: EMBED_ENTITY,
        role: "OWNER",
        adminMode: true,
        exp: EMBED_NOW + 60_000,
      },
      EMBED_SECRET,
    );
    expect(
      resolveEmbedPrincipal(
        remoteReq({ headers: { authorization: `Bearer ${token}` } }),
        EMBED_NOW,
        () => undefined,
      ),
    ).toBeNull();
    expect(
      resolveEmbedPrincipal(remoteReq(), EMBED_NOW, () => EMBED_SECRET),
    ).toBeNull();
  });

  it("returns claims for a valid token and null for a tampered one", () => {
    const token = mintEmbedSessionToken(
      {
        entityId: EMBED_ENTITY,
        role: "ADMIN",
        adminMode: false,
        exp: EMBED_NOW + 60_000,
      },
      EMBED_SECRET,
    );
    expect(
      resolveEmbedPrincipal(
        remoteReq({ headers: { authorization: `Bearer ${token}` } }),
        EMBED_NOW,
        () => EMBED_SECRET,
      ),
    ).toMatchObject({ entityId: EMBED_ENTITY, role: "ADMIN" });
    expect(
      resolveEmbedPrincipal(
        remoteReq({ headers: { authorization: `Bearer ${token}x` } }),
        EMBED_NOW,
        () => EMBED_SECRET,
      ),
    ).toBeNull();
  });
});

describe("ensureAuthSessionOrBootstrap", () => {
  it("returns session when the session cookie is present, even if a bearer is also set", () => {
    const result = ensureAuthSessionOrBootstrap(
      remoteReq({
        headers: {
          cookie: "eliza_session=cookie-sid",
          authorization: "Bearer bootstrap-token",
        },
      }),
    );
    expect(result).toEqual({ kind: "session", sessionId: "cookie-sid" });
  });

  it("returns bootstrap when only a bearer is present", () => {
    const result = ensureAuthSessionOrBootstrap(
      remoteReq({ headers: { authorization: "Bearer bootstrap-token" } }),
    );
    expect(result).toEqual({
      kind: "bootstrap",
      token: "bootstrap-token",
      bearer: "bootstrap-token",
    });
  });

  it("denies 401 and records a failure when neither cookie nor bearer is present", () => {
    const ip = "198.51.100.10";
    const denied = ensureAuthSessionOrBootstrap(
      remoteReq({ remoteAddress: ip }),
    );
    expect(denied).toEqual({
      kind: "denied",
      status: 401,
      reason: "auth_required",
    });

    for (let i = 0; i < AUTH_RATE_LIMIT_MAX - 1; i += 1) {
      expect(
        ensureAuthSessionOrBootstrap(remoteReq({ remoteAddress: ip })).kind,
      ).toBe("denied");
    }
    expect(
      ensureAuthSessionOrBootstrap(
        remoteReq({
          remoteAddress: ip,
          headers: { cookie: "eliza_session=sid" },
        }),
      ),
    ).toEqual({ kind: "denied", status: 429, reason: "rate_limited" });
  });

  it("treats a missing cookie name as absent and falls through to bootstrap", () => {
    const result = ensureAuthSessionOrBootstrap(
      remoteReq({
        headers: {
          cookie: "other=1",
          authorization: "Bearer only-bearer",
        },
      }),
    );
    expect(result).toEqual({
      kind: "bootstrap",
      token: "only-bearer",
      bearer: "only-bearer",
    });
  });
});

describe("ensureCompatApiAuthorized", () => {
  it("authorizes a trusted loopback request without a configured token", () => {
    const res = fakeRes();
    expect(ensureCompatApiAuthorized(loopbackReq(), res.res)).toBe(true);
    expect(res.status()).toBe(200);
  });

  it("rejects a remote request with 401 when no token is configured", () => {
    const res = fakeRes();
    expect(ensureCompatApiAuthorized(remoteReq(), res.res)).toBe(false);
    expect(res.status()).toBe(401);
    expect(res.json()).toEqual({ error: "Unauthorized" });
  });

  it("authorizes a remote caller presenting the configured token", () => {
    process.env.ELIZA_API_TOKEN = TOKEN;
    const res = fakeRes();
    expect(
      ensureCompatApiAuthorized(
        remoteReq({ headers: { authorization: `Bearer ${TOKEN}` } }),
        res.res,
      ),
    ).toBe(true);
    expect(res.status()).toBe(200);
  });

  it("rejects a mismatched token with 401 and rate-limits after 20 failures", () => {
    process.env.ELIZA_API_TOKEN = TOKEN;
    const ip = "198.51.100.20";
    for (let i = 0; i < AUTH_RATE_LIMIT_MAX; i += 1) {
      const res = fakeRes();
      expect(
        ensureCompatApiAuthorized(
          remoteReq({
            remoteAddress: ip,
            headers: { authorization: "Bearer wrong-token" },
          }),
          res.res,
        ),
      ).toBe(false);
      expect(res.status()).toBe(401);
    }
    const limited = fakeRes();
    expect(
      ensureCompatApiAuthorized(
        remoteReq({
          remoteAddress: ip,
          headers: { authorization: `Bearer ${TOKEN}` },
        }),
        limited.res,
      ),
    ).toBe(false);
    expect(limited.status()).toBe(429);
    expect(limited.json()).toEqual({
      error: "Too many authentication attempts",
    });
  });

  it("keeps rate-limit buckets per IP, including a null address as unknown", () => {
    process.env.ELIZA_API_TOKEN = TOKEN;
    for (let i = 0; i < AUTH_RATE_LIMIT_MAX; i += 1) {
      ensureCompatApiAuthorized(
        remoteReq({
          remoteAddress: null,
          headers: { authorization: "Bearer wrong" },
        }),
        fakeRes().res,
      );
    }
    const unknownLimited = fakeRes();
    expect(
      ensureCompatApiAuthorized(
        remoteReq({ remoteAddress: null }),
        unknownLimited.res,
      ),
    ).toBe(false);
    expect(unknownLimited.status()).toBe(429);

    const other = fakeRes();
    expect(
      ensureCompatApiAuthorized(
        remoteReq({
          remoteAddress: "198.51.100.30",
          headers: { authorization: `Bearer ${TOKEN}` },
        }),
        other.res,
      ),
    ).toBe(true);
    expect(other.status()).toBe(200);
  });

  it("clears limiter state through _resetAuthRateLimiter", () => {
    process.env.ELIZA_API_TOKEN = TOKEN;
    const ip = "198.51.100.40";
    for (let i = 0; i < AUTH_RATE_LIMIT_MAX; i += 1) {
      ensureCompatApiAuthorized(
        remoteReq({
          remoteAddress: ip,
          headers: { authorization: "Bearer wrong" },
        }),
        fakeRes().res,
      );
    }
    _resetAuthRateLimiter();
    const res = fakeRes();
    expect(
      ensureCompatApiAuthorized(
        remoteReq({
          remoteAddress: ip,
          headers: { authorization: `Bearer ${TOKEN}` },
        }),
        res.res,
      ),
    ).toBe(true);
  });
});

describe("ensureCompatSensitiveRouteAuthorized", () => {
  it("rejects a remote caller with 403 when no API token is configured", () => {
    const res = fakeRes();
    expect(ensureCompatSensitiveRouteAuthorized(remoteReq(), res.res)).toBe(
      false,
    );
    expect(res.status()).toBe(403);
    expect(res.json()).toEqual({
      error: "Sensitive endpoint requires API token authentication",
    });
  });

  it("delegates to the token gate when a token is configured", () => {
    process.env.ELIZA_API_TOKEN = TOKEN;
    const ok = fakeRes();
    expect(
      ensureCompatSensitiveRouteAuthorized(
        remoteReq({ headers: { authorization: `Bearer ${TOKEN}` } }),
        ok.res,
      ),
    ).toBe(true);
    const denied = fakeRes();
    expect(ensureCompatSensitiveRouteAuthorized(remoteReq(), denied.res)).toBe(
      false,
    );
    expect(denied.status()).toBe(401);
  });
});

describe("resolveAuthorizedRouteRole", () => {
  it("returns OWNER for a trusted loopback request before consulting the store", async () => {
    await expect(
      resolveAuthorizedRouteRole(loopbackReq(), {
        store: memoryStore({}),
      }),
    ).resolves.toEqual({ ok: true, role: "OWNER" });
  });

  it("rate-limits a remote caller after 20 failed attempts", async () => {
    const ip = "198.51.100.50";
    for (let i = 0; i < AUTH_RATE_LIMIT_MAX; i += 1) {
      await expect(
        resolveAuthorizedRouteRole(remoteReq({ remoteAddress: ip }), {
          state: { current: null },
        }),
      ).resolves.toEqual({ ok: false, status: 401, reason: "Unauthorized" });
    }
    await expect(
      resolveAuthorizedRouteRole(remoteReq({ remoteAddress: ip }), {
        state: { current: null },
      }),
    ).resolves.toEqual({
      ok: false,
      status: 429,
      reason: "Too many authentication attempts",
    });
  });

  it("grants OWNER from a matching API token when no store is available", async () => {
    process.env.ELIZA_API_TOKEN = TOKEN;
    await expect(
      resolveAuthorizedRouteRole(
        remoteReq({ headers: { authorization: `Bearer ${TOKEN}` } }),
        { state: { current: null } },
      ),
    ).resolves.toEqual({ ok: true, role: "OWNER" });
  });

  it("does not treat a matching API token as OWNER when a store exists unless local auth is required", async () => {
    process.env.ELIZA_API_TOKEN = TOKEN;
    await expect(
      resolveAuthorizedRouteRole(
        remoteReq({ headers: { authorization: `Bearer ${TOKEN}` } }),
        { store: memoryStore({}) },
      ),
    ).resolves.toEqual({ ok: false, status: 401, reason: "Unauthorized" });

    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    await expect(
      resolveAuthorizedRouteRole(
        remoteReq({ headers: { authorization: `Bearer ${TOKEN}` } }),
        { store: memoryStore({}) },
      ),
    ).resolves.toEqual({ ok: true, role: "OWNER" });
  });

  it("authorizes a cookie session as OWNER and skips CSRF on GET", async () => {
    const session = sessionRow({ id: "sess-owner", identityId: "id-owner" });
    const store = memoryStore({
      sessions: { "sess-owner": session },
      identities: { "id-owner": { id: "id-owner", kind: "owner" } },
    });
    await expect(
      resolveAuthorizedRouteRole(
        remoteReq({
          method: "GET",
          headers: { cookie: "eliza_session=sess-owner" },
        }),
        { store, now: EMBED_NOW },
      ),
    ).resolves.toEqual({
      ok: true,
      role: "OWNER",
      identityId: "id-owner",
    });
  });

  it("rejects a cookie POST without a matching CSRF header", async () => {
    const session = sessionRow({ id: "sess-csrf", identityId: "id-owner" });
    const store = memoryStore({
      sessions: { "sess-csrf": session },
      identities: { "id-owner": { id: "id-owner", kind: "owner" } },
    });
    await expect(
      resolveAuthorizedRouteRole(
        remoteReq({
          method: "POST",
          headers: { cookie: "eliza_session=sess-csrf" },
        }),
        { store, now: EMBED_NOW },
      ),
    ).resolves.toEqual({ ok: false, status: 403, reason: "csrf_required" });
  });

  it("accepts a cookie POST when the derived CSRF header matches", async () => {
    const session = sessionRow({ id: "sess-csrf-ok", identityId: "id-owner" });
    const store = memoryStore({
      sessions: { "sess-csrf-ok": session },
      identities: { "id-owner": { id: "id-owner", kind: "owner" } },
    });
    await expect(
      resolveAuthorizedRouteRole(
        remoteReq({
          method: "POST",
          headers: {
            cookie: "eliza_session=sess-csrf-ok",
            [CSRF_HEADER_NAME]: deriveCsrfToken(session),
          },
        }),
        { store, now: EMBED_NOW },
      ),
    ).resolves.toMatchObject({ ok: true, role: "OWNER" });
  });

  it("does not require CSRF for a bearer session on POST", async () => {
    const session = sessionRow({
      id: "sess-bearer",
      identityId: "id-machine",
      kind: "machine",
    });
    const store = memoryStore({
      sessions: { "sess-bearer": session },
      identities: { "id-machine": { id: "id-machine", kind: "machine" } },
    });
    await expect(
      resolveAuthorizedRouteRole(
        remoteReq({
          method: "POST",
          headers: { authorization: "Bearer sess-bearer" },
        }),
        { store, now: EMBED_NOW },
      ),
    ).resolves.toEqual({
      ok: true,
      role: "USER",
      identityId: "id-machine",
    });
  });

  it("ignores an ambient cookie when allowCookieAuth is false", async () => {
    const session = sessionRow({ id: "sess-ambient", identityId: "id-owner" });
    const store = memoryStore({
      sessions: { "sess-ambient": session },
      identities: { "id-owner": { id: "id-owner", kind: "owner" } },
    });
    await expect(
      resolveAuthorizedRouteRole(
        remoteReq({
          headers: { cookie: "eliza_session=sess-ambient" },
        }),
        { store, allowCookieAuth: false, now: EMBED_NOW },
      ),
    ).resolves.toEqual({ ok: false, status: 401, reason: "Unauthorized" });
  });

  it("falls through a missing session id to unauthorized", async () => {
    const store = memoryStore({});
    await expect(
      resolveAuthorizedRouteRole(
        remoteReq({
          headers: { cookie: "eliza_session=does-not-exist" },
        }),
        { store, now: EMBED_NOW },
      ),
    ).resolves.toEqual({ ok: false, status: 401, reason: "Unauthorized" });
  });

  it("maps a missing identity kind to NONE for an otherwise valid session", async () => {
    const session = sessionRow({ id: "sess-none", identityId: "id-gone" });
    const store = memoryStore({ sessions: { "sess-none": session } });
    await expect(
      resolveAuthorizedRouteRole(
        remoteReq({
          headers: { cookie: "eliza_session=sess-none" },
        }),
        { store, now: EMBED_NOW },
      ),
    ).resolves.toEqual({
      ok: true,
      role: "NONE",
      identityId: "id-gone",
    });
  });

  it("authorizes an embed ADMIN bearer as USER and records the principal", async () => {
    process.env.ELIZA_EMBED_SESSION_SECRET = EMBED_SECRET;
    const token = mintEmbedSessionToken(
      {
        entityId: EMBED_ENTITY,
        role: "ADMIN",
        adminMode: true,
        exp: EMBED_NOW + 60_000,
      },
      EMBED_SECRET,
    );
    await expect(
      resolveAuthorizedRouteRole(
        remoteReq({ headers: { authorization: `Bearer ${token}` } }),
        { store: memoryStore({}), now: EMBED_NOW },
      ),
    ).resolves.toEqual({
      ok: true,
      role: "USER",
      principal: EMBED_ENTITY,
    });
  });
});

describe("ensureCompatApiAuthorizedAsync", () => {
  it("returns true for an authorized store session and false after sending the denial", async () => {
    const session = sessionRow({ id: "sess-async", identityId: "id-owner" });
    const store = memoryStore({
      sessions: { "sess-async": session },
      identities: { "id-owner": { id: "id-owner", kind: "owner" } },
    });
    const ok = fakeRes();
    await expect(
      ensureCompatApiAuthorizedAsync(
        remoteReq({ headers: { cookie: "eliza_session=sess-async" } }),
        ok.res,
        { store, now: EMBED_NOW },
      ),
    ).resolves.toBe(true);

    const denied = fakeRes();
    await expect(
      ensureCompatApiAuthorizedAsync(remoteReq(), denied.res, {
        store: memoryStore({}),
      }),
    ).resolves.toBe(false);
    expect(denied.status()).toBe(401);
    expect(denied.json()).toEqual({ error: "Unauthorized" });
  });
});

describe("ensureRouteMinRole and ensureRouteAuthorized", () => {
  it("authorizes a loopback caller as OWNER", async () => {
    const res = fakeRes();
    await expect(
      ensureRouteMinRole(loopbackReq(), res.res, { current: null }, "OWNER"),
    ).resolves.toBe(true);
  });

  it("authorizes a no-store API token as OWNER and as USER", async () => {
    process.env.ELIZA_API_TOKEN = TOKEN;
    const ownerRes = fakeRes();
    await expect(
      ensureRouteMinRole(
        remoteReq({ headers: { authorization: `Bearer ${TOKEN}` } }),
        ownerRes.res,
        { current: null },
        "OWNER",
      ),
    ).resolves.toBe(true);
    const userRes = fakeRes();
    await expect(
      ensureRouteAuthorized(
        remoteReq({ headers: { authorization: `Bearer ${TOKEN}` } }),
        userRes.res,
        { current: null },
      ),
    ).resolves.toBe(true);
  });

  it("rejects a remote unauthenticated caller with 401", async () => {
    const res = fakeRes();
    await expect(
      ensureRouteAuthorized(remoteReq(), res.res, { current: null }),
    ).resolves.toBe(false);
    expect(res.status()).toBe(401);
    expect(res.json()).toEqual({ error: "Unauthorized" });
  });
});
