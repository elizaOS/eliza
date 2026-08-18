/**
 * Cookie-mutation CSRF guard — real `authMiddleware` + real
 * `cookieMutationGuardMiddleware` + the REAL organizations/invites route.
 *
 * Pins the W9-CLOUD-2 contract: a mutating request that would authenticate
 * through the ambient Steward session cookie must carry a first-party Origin
 * and a non-simple request marker, so cross-site hosted user content cannot
 * drive org mutations with the victim's cookie. Programmatic credentials
 * (API key / Bearer) and safe methods are exempt.
 *
 * Mocked seams: `getCurrentUser` / `requireUserOrApiKeyWithOrg` (session cookie
 * `steward-token=session-owner` or `X-API-Key: test-api-key` → org owner) and
 * `invitesService` (capture mocks — no DB).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { Hono } from "hono";
import * as realAuth from "@/lib/auth/workers-hono-auth";
import * as realInvites from "@/lib/services/invites";
import type { AppEnv } from "@/types/cloud-worker-env";
import { authMiddleware } from "../src/middleware/auth";
import { cookieMutationGuardMiddleware } from "../src/middleware/cookie-mutation-guard";

const OWNER = {
  id: "owner-1",
  organization_id: "org-1",
  role: "owner",
  is_active: true,
  organization: { id: "org-1", name: "Org", is_active: true },
};

function hasSessionCookie(c: {
  req: { header: (n: string) => string | undefined };
}): boolean {
  return (c.req.header("cookie") ?? "").includes("steward-token=session-owner");
}

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...realAuth,
  getCurrentUser: async (c: {
    req: { header: (n: string) => string | undefined };
  }) => (hasSessionCookie(c) ? OWNER : null),
  requireUserOrApiKeyWithOrg: async (c: {
    req: { header: (n: string) => string | undefined };
  }) => {
    if (c.req.header("x-api-key") === "test-api-key") return OWNER;
    if (c.req.header("authorization") === "Bearer eliza_test_key") return OWNER;
    if (hasSessionCookie(c)) return OWNER;
    throw new Error("Authentication required");
  },
}));

const createInvite = mock(async () => ({
  invite: {
    id: "inv-1",
    invited_email: "person@example.test",
    invited_role: "member",
    expires_at: new Date(0).toISOString(),
    status: "pending",
  },
  token: "invite-token",
}));
const listByOrganization = mock(async () => []);

mock.module("@/lib/services/invites", () => ({
  ...realInvites,
  invitesService: { createInvite, listByOrganization },
}));

const invitesRoute = (await import("../organizations/invites/route")).default;

const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];
const INVITES_URL = "http://localhost/api/organizations/invites";
const SESSION_COOKIE = "steward-token=session-owner";
const VALID_BODY = JSON.stringify({
  email: "person@example.test",
  role: "member",
});

// The route's STRICT limiter buckets cookie-authed traffic per client IP, so
// every request gets its own cf ip — a guard verdict under test must never be
// shadowed by a 429.
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

let app: Hono<AppEnv>;

function postInvites(headers: Record<string, string>) {
  return app.request(
    INVITES_URL,
    {
      method: "POST",
      headers: { "cf-connecting-ip": nextIp(), ...headers },
      body: VALID_BODY,
    },
    ENV,
  );
}

beforeEach(() => {
  app = new Hono<AppEnv>();
  app.use("*", authMiddleware);
  app.use("*", cookieMutationGuardMiddleware);
  app.route("/api/organizations/invites", invitesRoute);
  createInvite.mockClear();
  listByOrganization.mockClear();
});

describe("cookie-mutation guard on /api/organizations/invites", () => {
  test("cross-site simple POST with a session cookie → 403 forbidden_origin, handler never runs", async () => {
    // The finding's attack shape: hosted user content (same-site with the API)
    // POSTs a preflight-less form body; the browser attaches the cookie.
    const res = await postInvites({
      cookie: SESSION_COOKIE,
      origin: "https://evil.sites.eliza.app",
      "content-type": "text/plain",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      "forbidden_origin",
    );
    expect(createInvite).not.toHaveBeenCalled();
  });

  test("cookie-authed POST with no Origin/Referer → 403 forbidden_origin", async () => {
    const res = await postInvites({
      cookie: SESSION_COOKIE,
      "content-type": "application/json",
    });
    expect(res.status).toBe(403);
    expect(createInvite).not.toHaveBeenCalled();
  });

  test("cookie-authed POST from a non-first-party Origin → 403 even with a JSON marker", async () => {
    const res = await postInvites({
      cookie: SESSION_COOKIE,
      origin: "https://evil.sites.eliza.app",
      "content-type": "application/json",
    });
    expect(res.status).toBe(403);
    expect(createInvite).not.toHaveBeenCalled();
  });

  test("cookie-authed simple POST from a first-party Origin → 403 csrf_marker_required", async () => {
    const res = await postInvites({
      cookie: SESSION_COOKIE,
      origin: "https://cloud.eliza.app",
      "content-type": "text/plain",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      "csrf_marker_required",
    );
    expect(createInvite).not.toHaveBeenCalled();
  });

  test("cookie-authed DELETE with no Origin → 403 (guard fires before routing)", async () => {
    const res = await app.request(
      INVITES_URL,
      {
        method: "DELETE",
        headers: { cookie: SESSION_COOKIE, "cf-connecting-ip": nextIp() },
      },
      ENV,
    );
    expect(res.status).toBe(403);
  });

  test("first-party Origin + JSON marker → guard passes, invite is created", async () => {
    const res = await postInvites({
      cookie: SESSION_COOKIE,
      origin: "https://cloud.eliza.app",
      "content-type": "application/json",
    });
    expect(res.status).toBe(200);
    expect(createInvite).toHaveBeenCalledTimes(1);
  });

  test("a same-as-request-host Origin + the x-eliza-csrf header also passes", async () => {
    const res = await postInvites({
      cookie: SESSION_COOKIE,
      origin: "http://localhost",
      "x-eliza-csrf": "1",
      "content-type": "text/plain",
    });
    expect(res.status).toBe(200);
    expect(createInvite).toHaveBeenCalledTimes(1);
  });

  test("X-API-Key programmatic auth skips the guard entirely (no Origin needed)", async () => {
    const res = await postInvites({
      "x-api-key": "test-api-key",
      "content-type": "text/plain",
    });
    expect(res.status).toBe(200);
    expect(createInvite).toHaveBeenCalledTimes(1);
  });

  test("Bearer eliza_* programmatic auth skips the guard entirely", async () => {
    const res = await postInvites({
      authorization: "Bearer eliza_test_key",
      "content-type": "text/plain",
    });
    expect(res.status).toBe(200);
    expect(createInvite).toHaveBeenCalledTimes(1);
  });

  test("no credentials at all still 401s from the auth gate (guard adds no hole)", async () => {
    const res = await postInvites({ "content-type": "application/json" });
    expect(res.status).toBe(401);
    expect(createInvite).not.toHaveBeenCalled();
  });

  test("safe methods are exempt: cookie-authed GET with no Origin → 200", async () => {
    const res = await app.request(
      INVITES_URL,
      { headers: { cookie: SESSION_COOKIE, "cf-connecting-ip": nextIp() } },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(listByOrganization).toHaveBeenCalledTimes(1);
  });
});
