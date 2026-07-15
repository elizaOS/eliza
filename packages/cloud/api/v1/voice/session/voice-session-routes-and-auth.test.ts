/**
 * Unit coverage for the realtime voice-session HTTP edges. Platform auth,
 * Redis/JWT, provider transport, and route registry collaborators are mocked so
 * the tests can assert the route decisions directly.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
// Capture the REAL surface of every shared module a sibling changed-test also
// imports for real (jwt, session-registry, voice-usage-meter). The coverage
// lane runs all changed files in ONE bun process with no `--isolate`, and
// `mock.module` is process-global with no automatic per-file teardown — so a
// stub that drops exports here would make jwt.test.ts / protocol-and-
// aggregation.test.ts / voice-usage-meter.test.ts fail to resolve the real
// exports. We stub over a full passthrough and restore the real modules in
// afterAll so no sibling is contaminated.
import * as realCloudWorkerErrors from "@/lib/api/cloud-worker-errors";
import * as realVoiceUsageMeter from "@/lib/services/voice-usage-meter";
import * as realJwt from "@/lib/voice-session/jwt";
import * as realSessionRegistry from "@/lib/voice-session/session-registry";
import type { AppEnv } from "@/types/cloud-worker-env";

const realCloudWorkerErrorsExports = { ...realCloudWorkerErrors };
const realJwtExports = { ...realJwt };
const realSessionRegistryExports = { ...realSessionRegistry };
const realVoiceUsageMeterExports = { ...realVoiceUsageMeter };

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

// Resolve the shared/api src roots RELATIVE to this file so the absolute-
// specifier mocks work on any checkout (CI runner, fresh worktree) — not just
// the machine the test was authored on. bun canonicalizes a module import to
// its on-disk file: URL, so we register both the `@/`-alias form (source graph)
// and the resolved absolute form to guarantee the stub always wins.
const sharedRoot = new URL("../../../../shared/src", import.meta.url).href;
const apiRoot = new URL("../../../src", import.meta.url).href;

// The auth middleware pulls the real DB/plugin-sql graph transitively via
// `getCurrentUser`; stub `@elizaos/core` so that graph never has to resolve in
// the DB-free unit lane (matches the sibling mint-consent route test).
mock.module("@elizaos/core", () => ({
  isSensitiveKeyName: () => false,
  redactLogArgs: (a: unknown) => a,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  getCurrentUser: async () => authState.currentUser,
  requireUserOrApiKeyWithOrg: async () => authState.requiredUser,
}));
mock.module(`${sharedRoot}/lib/auth/workers-hono-auth.ts`, () => ({
  getCurrentUser: async () => authState.currentUser,
  requireUserOrApiKeyWithOrg: async () => authState.requiredUser,
}));

// Passthrough stub: keep ApiError and the rest of the real export surface so
// sibling changed-tests in the same non-isolated coverage-lane process (e.g.
// provisioning-jobs-delete-enqueue.test.ts) still resolve them.
const cloudWorkerErrorsStub = () => ({
  ...realCloudWorkerErrorsExports,
  jsonError: (
    c: { json: (body: unknown, status: number) => Response },
    status: number,
    message: string,
    code: string,
  ) => c.json({ error: message, code }, status),
});
mock.module("@/lib/api/cloud-worker-errors", cloudWorkerErrorsStub);
mock.module(
  `${sharedRoot}/lib/api/cloud-worker-errors.ts`,
  cloudWorkerErrorsStub,
);

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

const sessionRegistryStub = () => ({
  ...realSessionRegistryExports,
  getVoiceSessionRegistry: () => ({
    size: () => registryState.size,
    get: () => registryState.live,
    severBySessionId: (id: string, reason: string) => {
      registryState.severed.push({ id, reason });
      return Boolean(registryState.live);
    },
  }),
});
mock.module("@/lib/voice-session/session-registry", sessionRegistryStub);
mock.module(
  `${sharedRoot}/lib/voice-session/session-registry.ts`,
  sessionRegistryStub,
);

const jwtStub = () => ({
  ...realJwtExports,
  lookupVoiceSessionJti: async () => jwtState.lookupJti,
  revokeVoiceSessionToken: async (jti: string) => {
    if (jwtState.revokeError) throw jwtState.revokeError;
    jwtState.revoked.push(jti);
  },
  claimVoiceSessionToken: async () => ({ ok: true }),
  verifyVoiceSessionToken: async () => ({ ok: true }),
  isVoiceSessionTokenRevoked: async () => false,
});
mock.module("@/lib/voice-session/jwt", jwtStub);
mock.module(`${sharedRoot}/lib/voice-session/jwt.ts`, jwtStub);

const voiceUsageMeterStub = () => ({
  ...realVoiceUsageMeterExports,
  InMemoryVoiceUsageStore: class {},
  createDurableVoiceUsageStore: () => null,
});
mock.module("@/lib/services/voice-usage-meter", voiceUsageMeterStub);
mock.module(
  `${sharedRoot}/lib/services/voice-usage-meter.ts`,
  voiceUsageMeterStub,
);

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

// Restore the real shared modules so sibling changed-tests in the same (non-
// isolated) coverage-lane process see the full export surface, not our stubs.
afterAll(() => {
  mock.module(
    "@/lib/api/cloud-worker-errors",
    () => realCloudWorkerErrorsExports,
  );
  mock.module(
    `${sharedRoot}/lib/api/cloud-worker-errors.ts`,
    () => realCloudWorkerErrorsExports,
  );
  mock.module("@/lib/voice-session/jwt", () => realJwtExports);
  mock.module(`${sharedRoot}/lib/voice-session/jwt.ts`, () => realJwtExports);
  mock.module(
    "@/lib/voice-session/session-registry",
    () => realSessionRegistryExports,
  );
  mock.module(
    `${sharedRoot}/lib/voice-session/session-registry.ts`,
    () => realSessionRegistryExports,
  );
  mock.module(
    "@/lib/services/voice-usage-meter",
    () => realVoiceUsageMeterExports,
  );
  mock.module(
    `${sharedRoot}/lib/services/voice-usage-meter.ts`,
    () => realVoiceUsageMeterExports,
  );
});

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

function requestWithEnv(
  app: Hono<AppEnv>,
  path: string,
  init: RequestInit = {},
  env: Record<string, string> = {},
) {
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

function requestRevoke(
  path: string,
  init: RequestInit = { method: "POST" },
  env: Record<string, string> = {},
) {
  const parent = new Hono<AppEnv>();
  parent.route("/:id/revoke", revokeRoute);
  return requestWithEnv(parent, path, init, env);
}

describe("auth middleware public path decisions", () => {
  test("keeps only the websocket voice-session endpoint public", () => {
    expect(authModule.isPublicPath("/api/v1/voice/session/ws")).toBe(true);
    expect(authModule.isPublicPath("/api/v1/voice/session/ws/extra")).toBe(
      true,
    );
    expect(authModule.isPublicPath("/api/v1/voice/session")).toBe(false);
    expect(
      authModule.isPublicPath("/api/v1/voice/session/session-a/revoke"),
    ).toBe(false);
  });

  test("passes public, programmatic, local dev admin, and steward-authenticated requests", async () => {
    resetState();
    const app = new Hono<AppEnv>();
    app.use("*", authModule.authMiddleware);
    app.get("*", (c) => c.json({ ok: true }));

    expect((await requestWithEnv(app, "/api/v1/voice/session/ws")).status).toBe(
      200,
    );
    expect(
      (
        await requestWithEnv(app, "/api/protected", {
          headers: { "X-API-Key": "key" },
        })
      ).status,
    ).toBe(200);
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
    const app = new Hono<AppEnv>();
    app.use("*", authModule.authMiddleware);
    app.get("*", (c) => c.json({ ok: true }));

    const unauth = await requestWithEnv(app, "/api/protected");
    expect(unauth.status).toBe(401);
    expect((await unauth.json()) as unknown).toEqual({
      error: "Unauthorized",
      code: "authentication_required",
    });

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
    expect(
      (
        await requestRevoke(
          "/session-a/revoke",
          { method: "POST" },
          { VOICE_REALTIME_WS_ENABLED: "false" },
        )
      ).status,
    ).toBe(404);
    expect(
      (await requestWithEnv(revokeRoute, "/", { method: "POST" })).status,
    ).toBe(400);
  });

  test("refuses same-org peer access to a live session without leaking existence", async () => {
    resetState();
    registryState.live = {
      organizationId: "org-a",
      userId: "user-b",
      jti: "jti-live",
    };
    const res = await requestRevoke("/session-a/revoke", { method: "POST" });
    expect(res.status).toBe(404);
    expect(jwtState.revoked).toEqual([]);
    expect(registryState.severed).toEqual([]);
  });

  test("revokes live and directory-backed sessions and fails loud on durable revoke errors", async () => {
    resetState();
    registryState.live = {
      organizationId: "org-a",
      userId: "user-a",
      jti: "jti-live",
    };
    const live = await requestRevoke("/session-a/revoke", { method: "POST" });
    expect(live.status).toBe(200);
    expect((await live.json()) as unknown).toEqual({
      revoked: true,
      severed: true,
    });
    expect(jwtState.revoked).toEqual(["jti-live"]);
    expect(registryState.severed).toEqual([
      { id: "session-a", reason: "revoked" },
    ]);

    resetState();
    jwtState.lookupJti = "jti-directory";
    const remote = await requestRevoke("/session-b/revoke", { method: "POST" });
    expect(remote.status).toBe(200);
    expect((await remote.json()) as unknown).toEqual({
      revoked: true,
      severed: false,
    });
    expect(jwtState.revoked).toEqual(["jti-directory"]);

    resetState();
    jwtState.lookupJti = "jti-broken";
    jwtState.revokeError = new Error("redis down");
    const failed = await requestRevoke("/session-c/revoke", { method: "POST" });
    expect(failed.status).toBe(503);
    expect((await failed.json()) as unknown).toEqual({
      error: "revoke failed",
    });
  });
});

describe("voice session websocket route", () => {
  test("returns explicit status codes before any provider socket opens", async () => {
    resetState();
    expect(
      (
        await requestWithEnv(wsRoute, "/", undefined, {
          VOICE_REALTIME_WS_ENABLED: "false",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await requestWithEnv(wsRoute, "/", {
          headers: { Upgrade: "not-websocket" },
        })
      ).status,
    ).toBe(426);
    expect(
      (
        await requestWithEnv(wsRoute, "/", {
          headers: { Upgrade: "websocket" },
        })
      ).status,
    ).toBe(400);

    registryState.size = 200;
    const capacity = await requestWithEnv(wsRoute, "/?sessionId=s", {
      headers: { Upgrade: "websocket" },
    });
    expect(capacity.status).toBe(503);
    expect((await capacity.json()) as unknown).toEqual({
      error: "voice realtime capacity reached",
      code: "at_capacity",
    });

    resetState();
    const misconfigured = await requestWithEnv(
      wsRoute,
      "/?sessionId=s",
      { headers: { Upgrade: "websocket" } },
      { CARTESIA_API_KEY: "" },
    );
    expect(misconfigured.status).toBe(503);
    expect((await misconfigured.json()) as unknown).toEqual({
      error: "voice realtime session misconfigured",
    });

    const transport = await requestWithEnv(wsRoute, "/?sessionId=s", {
      headers: { Upgrade: "websocket" },
    });
    expect(transport.status).toBe(503);
    expect((await transport.json()) as unknown).toEqual({
      error: "voice realtime transport unavailable",
    });
  });
});
