/**
 * Auth audit IP attribution (W9-CLOUD-3) — real steward-session + logout route
 * modules, the real OIDC audit emitter, and the real local-dev-admin audit
 * path in `authMiddleware`, all emitting through the REAL AuditDispatcher into
 * an in-memory sink. Asserts the recorded `ip` is the Cloudflare-attested
 * `cf-connecting-ip`, never the client-spoofable leftmost `x-forwarded-for`,
 * and that the failed-login / logout actions are registered with the
 * dispatcher (previously they were rejected as unknown actions and dropped).
 *
 * Mocked seams: Steward token verify, user sync/lookup, session teardown,
 * SSO-bridge marker store, and the audit-dispatcher singleton (replaced by a
 * real dispatcher wired to InMemorySink, so action registration and metadata
 * redaction are exercised for real).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.NODE_ENV ||= "test";

import { Hono } from "hono";
import * as realAuth from "@/lib/auth/workers-hono-auth";
import { authMiddleware } from "../src/middleware/auth";
import type { EmitInput } from "../src/services/audit";
import { AuditDispatcher } from "../src/services/audit";
import { InMemorySink } from "../src/services/audit/testing.js";

const sink = new InMemorySink();
const dispatcher = new AuditDispatcher({ sinks: [sink] });
const emitSpy = mock((input: EmitInput) => dispatcher.emit(input));

mock.module("@/api-app/services/audit-dispatcher-singleton", () => ({
  getAuditDispatcher: () => ({ emit: emitSpy }),
  initAuditDispatcher: () => dispatcher,
  setAuditDispatcher: () => undefined,
}));

const verifyStewardTokenCached = mock(async (_env: unknown, token: string) => {
  if (token === "plain-token" || token === "logout-token") {
    return {
      userId: "steward-user-1",
      email: "person@example.test",
      expiration: Math.floor(Date.now() / 1000) + 900,
      issuedAt: Math.floor(Date.now() / 1000) - 60,
    };
  }
  return null;
});

mock.module("@/lib/auth/steward-client", () => ({
  verifyStewardTokenCached,
}));

const syncUserFromSteward = mock(async () => ({
  id: "cloud-user-1",
  organization_id: "org-1",
  initialCreditsGranted: false,
  initialFreeCreditsUsd: "0.00",
  welcomeBonusWithheld: false,
  welcomeBonusWithheldReason: undefined,
  welcomeBonusWithheldMessage: undefined,
}));

mock.module("@/lib/steward-sync", () => ({
  describeSyncError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  StewardPhoneAccountConflictError: class extends Error {},
  StewardTelegramAccountClaimError: class extends Error {},
  syncUserFromSteward,
}));

const LOGOUT_USER = {
  id: "cloud-user-1",
  organization_id: "org-1",
  is_active: true,
};

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...realAuth,
  getCurrentUser: async (c: {
    req: { header: (n: string) => string | undefined };
  }) =>
    (c.req.header("cookie") ?? "").includes(
      "steward-token-staging=logout-token",
    )
      ? LOGOUT_USER
      : null,
}));

mock.module("@/lib/auth", () => ({
  invalidateSessionCaches: mock(async () => {}),
}));

const markSsoBridgeLogout = mock(async () => {});
mock.module("@/lib/services/sso-bridge-codes", () => ({
  isBlockedBySsoBridgeLogout: mock(async () => false),
  markSsoBridgeLogout,
}));

const endAllUserSessions = mock(async () => {});
mock.module("@/lib/services/user-sessions", () => ({
  userSessionsService: { endAllUserSessions },
}));

mock.module("@/lib/services/inference-credential-revocation", () => ({
  isInferenceStrongRevocationEnabled: () => false,
  revokeInferenceSessionsThrough: mock(async () => {}),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { default: stewardSessionRoute } = await import(
  "../auth/steward-session/route"
);
const { default: logoutRoute } = await import("../auth/logout/route");
const { emitOidcAudit } = await import("../oidc/audit");

const ENV = {
  ENVIRONMENT: "staging",
  NODE_ENV: "production",
  STEWARD_SESSION_SECRET: "test-secret",
};

const CF_IP = "203.0.113.77";
const SPOOFED_XFF = "198.51.100.99, 10.0.0.1";

function attributedHeaders(): Record<string, string> {
  return {
    "cf-connecting-ip": CF_IP,
    "x-forwarded-for": SPOOFED_XFF,
    origin: "https://staging.elizacloud.ai",
    "content-type": "application/json",
  };
}

function lastEvent() {
  const events = sink.snapshot();
  return events[events.length - 1];
}

beforeEach(() => {
  sink.clear();
  emitSpy.mockClear();
  verifyStewardTokenCached.mockClear();
});

describe("auth audit events attribute the Cloudflare-attested IP", () => {
  test("steward-session invalid token → auth.login.failed records cf-connecting-ip", async () => {
    const app = new Hono();
    app.route("/api/auth/steward-session", stewardSessionRoute);
    const res = await app.fetch(
      new Request(
        "https://api-staging.elizacloud.ai/api/auth/steward-session",
        {
          method: "POST",
          headers: attributedHeaders(),
          body: JSON.stringify({ token: "bad-token" }),
        },
      ),
      ENV,
    );
    expect(res.status).toBe(401);
    const event = lastEvent();
    expect(event?.action).toBe("auth.login.failed");
    expect(event?.result).toBe("failure");
    expect(event?.ip).toBe(CF_IP);
  });

  test("steward-session success → auth.login records cf-connecting-ip", async () => {
    const app = new Hono();
    app.route("/api/auth/steward-session", stewardSessionRoute);
    const res = await app.fetch(
      new Request(
        "https://api-staging.elizacloud.ai/api/auth/steward-session",
        {
          method: "POST",
          headers: attributedHeaders(),
          body: JSON.stringify({ token: "plain-token" }),
        },
      ),
      ENV,
    );
    expect(res.status).toBe(200);
    const event = lastEvent();
    expect(event?.action).toBe("auth.login");
    expect(event?.ip).toBe(CF_IP);
  });

  test("logout → auth.logout records cf-connecting-ip", async () => {
    const app = new Hono();
    app.route("/api/auth/logout", logoutRoute);
    const res = await app.fetch(
      new Request("https://api-staging.elizacloud.ai/api/auth/logout", {
        method: "POST",
        headers: {
          ...attributedHeaders(),
          cookie: "steward-token-staging=logout-token",
        },
      }),
      ENV,
    );
    expect(res.status).toBe(200);
    const event = lastEvent();
    expect(event?.action).toBe("auth.logout");
    expect(event?.ip).toBe(CF_IP);
  });

  test("OIDC audit emitter records cf-connecting-ip", async () => {
    const headers: Record<string, string> = {
      "cf-connecting-ip": CF_IP,
      "x-forwarded-for": SPOOFED_XFF,
      "user-agent": "oidc-test",
    };
    const fakeContext = {
      req: { header: (name: string) => headers[name.toLowerCase()] },
      get: () => "req-oidc-1",
    };
    await emitOidcAudit(fakeContext as never, {
      action: "oidc.token",
      result: "success",
      userId: "cloud-user-1",
    });
    const event = lastEvent();
    expect(event?.action).toBe("oidc.token");
    expect(event?.ip).toBe(CF_IP);
  });

  test("local-dev-admin bypass audit records cf-connecting-ip", async () => {
    const app = new Hono();
    app.use("*", authMiddleware);
    app.post("/api/v1/admin/ping", (c) => c.json({ ok: true }));
    const res = await app.fetch(
      new Request("http://localhost/api/v1/admin/ping", {
        method: "POST",
        headers: {
          "cf-connecting-ip": CF_IP,
          "x-forwarded-for": SPOOFED_XFF,
        },
      }),
      { NODE_ENV: "development", ELIZA_CLOUD_LOCAL_DEV_ADMIN: "true" },
    );
    expect(res.status).toBe(200);
    // The bypass audit is emitted fire-and-forget (void + .catch) — let the
    // in-process fan-out settle before reading the sink.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const event = lastEvent();
    expect(event?.action).toBe("admin.action");
    expect(event?.ip).toBe(CF_IP);
  });
});
