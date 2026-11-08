import { beforeEach, expect, mock, test } from "bun:test";
import { HTTPException } from "hono/http-exception";

let authenticated = true,
  privateOwner = true,
  configured = true;
let exchange: (input: unknown) => Promise<unknown>;
const calls: unknown[] = [];
const invalidations: unknown[] = [];

mock.module("@elizaos/cloud-shared/auth", () => ({
  requireUserOrApiKeyWithOrg: async () => {
    if (!authenticated) throw new HTTPException(401);
    return { id: "owner-1", organization_id: "org-1" };
  },
  requirePrivateOwnerAccess: async () => {
    if (!privateOwner) throw new HTTPException(403);
  },
}));
mock.module(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare",
  () => ({
    RateLimitPresets: { STRICT: { windowMs: 60_000, maxRequests: 10 } },
    rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  }),
);
mock.module(
  "@elizaos/cloud-shared/lib/services/oauth/provider-registry",
  () => ({
    getProvider: (id: string) => (id === "google" ? { id: "google" } : null),
    isProviderConfigured: () => configured,
  }),
);
mock.module("@elizaos/cloud-shared/lib/services/oauth/providers", () => ({
  exchangeGoogleServerAuthCode: async (_provider: unknown, input: unknown) => {
    calls.push(input);
    return exchange(input);
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/oauth/invalidation", () => ({
  invalidateOAuthState: async (...args: unknown[]) => {
    invalidations.push(["oauth", ...args]);
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/eliza-app", () => ({
  connectionEnforcementService: {
    invalidateRequiredConnectionCache: async (...args: unknown[]) => {
      invalidations.push(["enforcement", ...args]);
    },
  },
}));

const { default: app } = await import("./route");

const post = (body: unknown) =>
  app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  authenticated = true;
  privateOwner = true;
  configured = true;
  calls.length = 0;
  invalidations.length = 0;
  exchange = async () => ({
    connectionId: "conn-1",
    organizationId: "org-1",
    userId: "owner-1",
    platformUserId: "google-sub",
    email: "owner@example.com",
    displayName: "Owner",
    scopes: ["openid", "https://www.googleapis.com/auth/calendar.events"],
    refreshTokenIssued: true,
  });
});

test("binds the authenticated owner, stores the connection and invalidates caches", async () => {
  const response = await post({ serverAuthCode: "4/0AeaYSHnative" });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()) as unknown).toEqual({
    connected: true,
    connectionId: "conn-1",
    email: "owner@example.com",
    displayName: "Owner",
    scopes: ["openid", "https://www.googleapis.com/auth/calendar.events"],
    refreshTokenIssued: true,
  });
  expect(calls).toEqual([
    {
      organizationId: "org-1",
      userId: "owner-1",
      serverAuthCode: "4/0AeaYSHnative",
    },
  ]);
  expect(invalidations).toEqual([
    ["oauth", "org-1", "google", "owner-1"],
    ["enforcement", "org-1", "owner-1"],
  ]);
});

test("rejects malformed bodies and tenant overrides before any exchange", async () => {
  for (const body of [
    "not json",
    {},
    { serverAuthCode: "short" },
    { serverAuthCode: "4/0 has spaces in it" },
    { serverAuthCode: "4/0AeaYSHnative", organizationId: "other" },
  ]) {
    expect((await post(body)).status).toBe(400);
  }
  expect(calls).toHaveLength(0);
});

test("auth, owner and configuration checks happen before the exchange", async () => {
  authenticated = false;
  expect((await post({ serverAuthCode: "4/0AeaYSHnative" })).status).toBe(401);
  authenticated = true;
  privateOwner = false;
  expect((await post({ serverAuthCode: "4/0AeaYSHnative" })).status).toBe(403);
  privateOwner = true;
  configured = false;
  const unconfigured = await post({ serverAuthCode: "4/0AeaYSHnative" });
  expect(unconfigured.status).toBe(503);
  expect(((await unconfigured.json()) as { code: string }).code).toBe(
    "google_not_configured",
  );
  expect(calls).toHaveLength(0);
});

test("Google refusals and outages map to typed errors", async () => {
  exchange = async () => {
    throw new Error("Token exchange failed: 400");
  };
  const rejected = await post({ serverAuthCode: "4/0AeaYSHnative" });
  expect(rejected.status).toBe(400);
  expect(((await rejected.json()) as { code: string }).code).toBe(
    "google_code_rejected",
  );
  exchange = async () => {
    throw new Error("GOOGLE_GRANTED_SCOPES_REQUIRED");
  };
  const noScopes = await post({ serverAuthCode: "4/0AeaYSHnative" });
  expect(((await noScopes.json()) as { code: string }).code).toBe(
    "google_scopes_missing",
  );
  exchange = async () => {
    throw new Error("Token exchange failed: 503");
  };
  const outage = await post({ serverAuthCode: "4/0AeaYSHnative" });
  expect(outage.status).toBe(502);
  expect(((await outage.json()) as { code: string }).code).toBe(
    "google_unavailable",
  );
  expect(invalidations).toHaveLength(0);
});
