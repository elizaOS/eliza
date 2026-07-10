/**
 * Unit coverage for the realtime voice-session HTTP edges. Platform auth,
 * Redis/JWT, provider transport, and route registry collaborators are mocked so
 * the tests can assert the route decisions directly.
 */

import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const authState = {
  currentUser: null as null | { id: string },
  requiredUser: { id: "user-a", organization_id: "org-a" },
};
const auditEvents: unknown[] = [];
const registryState = {
  size: 0,
  live: null as null | { organizationId: string; userId: string; jti: string },
  severed: [] as Array<{ id: string; reason: string }>,
};
const jwtState = {
  lookupJti: null as null | string,
  revokeError: null as null | Error,
  revoked: [] as string[],
};

const sharedRoot = "file:///home/shad0w/eliza-workers/wt-voice-slice/packages/cloud/shared/src";
const apiRoot = "file:///home/shad0w/eliza-workers/wt-voice-slice/packages/cloud/api/src";

mock.module("@/lib/auth/workers-hono-auth", () => ({
  getCurrentUser: async () => authState.currentUser,
  requireUserOrApiKeyWithOrg: async () => authState.requiredUser,
}));
mock.module(`${sharedRoot}/lib/auth/workers-hono-auth.ts`, () => ({
  getCurrentUser: async () => authState.currentUser,
  requireUserOrApiKeyWithOrg: async () => authState.requiredUser,
}));

mock.module("@/lib/api/cloud-worker-errors", () => ({
  jsonError: (c: { json: (body: unknown, status: number) => Response }, status: number, message: string, code: string) =>
    c.json({ error: message, code }, status),
}));
mock.module(`${sharedRoot}/lib/api/cloud-worker-errors.ts`, () => ({
  jsonError: (c: { json: (body: unknown, status: number) => Response }, status: number, message: string, code: string) =>
    c.json({ error: message, code }, status),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
  },
}));
mock.module(`${sharedRoot}/lib/utils/logger.ts`, () => ({
  logger: {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
  },
}));

mock.module("../services/audit-dispatcher-singleton", () => ({
  getAuditDispatcher: () => ({
    emit: async (event: unknown) => {
      auditEvents.push(event);
    },
  }),
}));
mock.module(`${apiRoot}/services/audit-dispatcher-singleton.ts`, () => ({
  getAuditDispatcher: () => ({
    emit: async (event: unknown) => {
      auditEvents.push(event);
    },
  }),
}));

mock.module("@/lib/voice-session/session-registry", () => ({
  getVoiceSessionRegistry: () => ({
    size: () => registryState.size,
    get: () => registryState.live,
    severBySessionId: (id: string, reason: string) => {
      registryState.severed.push({ id, reason });
      return Boolean(registryState.live);
    },
  }),
}));
mock.module(`${sharedRoot}/lib/voice-session/session-registry.ts`, () => ({
  getVoiceSessionRegistry: () => ({
    size: () => registryState.size,
    get: () => registryState.live,
    severBySessionId: (id: string, reason: string) => {
      registryState.severed.push({ id, reason });
      return Boolean(registryState.live);
    },
  }),
}));

mock.module("@/lib/voice-session/jwt", () => ({
  lookupVoiceSessionJti: async () => jwtState.lookupJti,
  revokeVoiceSessionToken: async (jti: string) => {
    if (jwtState.revokeError) throw jwtState.revokeError;
    jwtState.revoked.push(jti);
  },
  claimVoiceSessionToken: async () => ({ ok: true }),
  verifyVoiceSessionToken: async () => ({ ok: true }),
  isVoiceSessionTokenRevoked: async () => false,
}));
mock.module(`${sharedRoot}/lib/voice-session/jwt.ts`, () => ({
  lookupVoiceSessionJti: async () => jwtState.lookupJti,
  revokeVoiceSessionToken: async (jti: string) => {
    if (jwtState.revokeError) throw jwtState.revokeError;
    jwtState.revoked.push(jti);
  },
  claimVoiceSessionToken: async () => ({ ok: true }),
  verifyVoiceSessionToken: async () => ({ ok: true }),
  isVoiceSessionTokenRevoked: async () => false,
}));

mock.module("@/lib/services/voice-usage-meter", () => ({
  InMemoryVoiceUsageStore: class {},
  createDurableVoiceUsageStore: () => null,
}));
mock.module(`${sharedRoot}/lib/services/voice-usage-meter.ts`, () => ({
  InMemoryVoiceUsageStore: class {},
  createDurableVoiceUsageStore: () => null,
}));

mock.module("@/lib/cache/redis-factory", () => ({
  buildRedisClient: () => null,
}));
mock.module(`${sharedRoot}/lib/cache/redis-factory.ts`, () => ({
  buildRedisClient: () => null,
}));

mock.module("../lib/session", () => ({
  VoiceSession: class {
    constructor(readonly options: unknown) {}
  },
}));

const authModule = await import("../../../src/middleware/auth");
const revokeRoute = (await import("./[id]/revoke/route")).default;
const wsRoute = (await import("./ws/route")).default;

function resetState() {
  authState.currentUser = null;
  authState.requiredUser = { id: "user-a", organization_id: "org-a" };
  auditEvents.length = 0;
  registryState.size = 0;
  registryState.live = null;
  registryState.severed.length = 0;
  jwtState.lookupJti = null;
  jwtState.revokeError = null;
  jwtState.revoked.length = 0;
}

function requestWithEnv(app: Hono, path: string, init: RequestInit = {}, env: Record<string, string> = {}) {
  return app.request(path, init, {
    VOICE_REALTIME_WS_ENABLED: "true",
    DEEPGRAM_API_KEY: "dg",
    CARTESIA_API_KEY: "cartesia",
    VOICE_REALTIME_CARTESIA_VOICE_ID: "voice",
    VOICE_REALTIME_ELIZA_ENDPOINT: "https://eliza.test/sse",
    VOICE_REALTIME_ELIZA_AUTHORIZATION: "Bearer service",
    ...env,
  });
}

function requestRevoke(path: string, init: RequestInit = { method: "POST" }, env: Record<string, string> = {}) {
  const parent = new Hono();
  parent.route("/:id/revoke", revokeRoute);
  return requestWithEnv(parent, path, init, env);
}

describe("auth middleware public path decisions", () => {
  test("keeps only the websocket voice-session endpoint public", () => {
    expect(authModule.isPublicPath("/api/v1/voice/session/ws")).toBe(true);
    expect(authModule.isPublicPath("/api/v1/voice/session/ws/extra")).toBe(true);
    expect(authModule.isPublicPath("/api/v1/voice/session")).toBe(false);
    expect(authModule.isPublicPath("/api/v1/voice/session/session-a/revoke")).toBe(false);
  });

  test("passes public, programmatic, local dev admin, and steward-authenticated requests", async () => {
    resetState();
    const app = new Hono();
    app.use("*", authModule.authMiddleware);
    app.get("*", (c) => c.json({ ok: true }));

    expect((await requestWithEnv(app, "/api/v1/voice/session/ws")).status).toBe(200);
    expect((await requestWithEnv(app, "/api/protected", { headers: { "X-API-Key": "key" } })).status).toBe(200);
    expect(
      (
        await requestWithEnv(
          app,
          "http://localhost/api/v1/admin/metrics",
          { headers: { "x-forwarded-for": "127.0.0.1" } },
          { LOCAL_DEV: "true", NODE_ENV: "development" },
        )
      ).status,
    ).toBe(200);
    expect(auditEvents.length).toBe(1);

    authState.currentUser = { id: "user-a" };
    expect((await requestWithEnv(app, "/api/protected")).status).toBe(200);
  });

  test("rejects protected API paths without a session and refuses dev bypass in production", async () => {
    resetState();
    const app = new Hono();
    app.use("*", authModule.authMiddleware);
    app.get("*", (c) => c.json({ ok: true }));

    const unauth = await requestWithEnv(app, "/api/protected");
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toEqual({ error: "Unauthorized", code: "authentication_required" });

    const prodDev = await requestWithEnv(
      app,
      "http://localhost/api/v1/admin/metrics",
      undefined,
      { LOCAL_DEV: "true", NODE_ENV: "production" },
    );
    expect(prodDev.status).toBe(401);
  });
});

describe("voice session revoke route", () => {
  test("is flag gated and validates session id", async () => {
    resetState();
    expect((await requestRevoke("/session-a/revoke", { method: "POST" }, { VOICE_REALTIME_WS_ENABLED: "false" })).status).toBe(404);
    expect((await requestWithEnv(revokeRoute, "/", { method: "POST" })).status).toBe(400);
  });

  test("refuses same-org peer access to a live session without leaking existence", async () => {
    resetState();
    registryState.live = { organizationId: "org-a", userId: "user-b", jti: "jti-live" };
    const res = await requestRevoke("/session-a/revoke", { method: "POST" });
    expect(res.status).toBe(404);
    expect(jwtState.revoked).toEqual([]);
    expect(registryState.severed).toEqual([]);
  });

  test("revokes live and directory-backed sessions and fails loud on durable revoke errors", async () => {
    resetState();
    registryState.live = { organizationId: "org-a", userId: "user-a", jti: "jti-live" };
    const live = await requestRevoke("/session-a/revoke", { method: "POST" });
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ revoked: true, severed: true });
    expect(jwtState.revoked).toEqual(["jti-live"]);
    expect(registryState.severed).toEqual([{ id: "session-a", reason: "revoked" }]);

    resetState();
    jwtState.lookupJti = "jti-directory";
    const remote = await requestRevoke("/session-b/revoke", { method: "POST" });
    expect(remote.status).toBe(200);
    expect(await remote.json()).toEqual({ revoked: true, severed: false });
    expect(jwtState.revoked).toEqual(["jti-directory"]);

    resetState();
    jwtState.lookupJti = "jti-broken";
    jwtState.revokeError = new Error("redis down");
    const failed = await requestRevoke("/session-c/revoke", { method: "POST" });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "revoke failed" });
  });
});

describe("voice session websocket route", () => {
  test("returns explicit status codes before any provider socket opens", async () => {
    resetState();
    expect((await requestWithEnv(wsRoute, "/", undefined, { VOICE_REALTIME_WS_ENABLED: "false" })).status).toBe(404);
    expect((await requestWithEnv(wsRoute, "/", { headers: { Upgrade: "not-websocket" } })).status).toBe(426);
    expect((await requestWithEnv(wsRoute, "/", { headers: { Upgrade: "websocket" } })).status).toBe(400);

    registryState.size = 200;
    const capacity = await requestWithEnv(wsRoute, "/?sessionId=s", { headers: { Upgrade: "websocket" } });
    expect(capacity.status).toBe(503);
    expect(await capacity.json()).toEqual({ error: "voice realtime capacity reached", code: "at_capacity" });

    resetState();
    const misconfigured = await requestWithEnv(
      wsRoute,
      "/?sessionId=s",
      { headers: { Upgrade: "websocket" } },
      { CARTESIA_API_KEY: "" },
    );
    expect(misconfigured.status).toBe(503);
    expect(await misconfigured.json()).toEqual({ error: "voice realtime session misconfigured" });

    const transport = await requestWithEnv(wsRoute, "/?sessionId=s", { headers: { Upgrade: "websocket" } });
    expect(transport.status).toBe(503);
    expect(await transport.json()).toEqual({ error: "voice realtime transport unavailable" });
  });
});
