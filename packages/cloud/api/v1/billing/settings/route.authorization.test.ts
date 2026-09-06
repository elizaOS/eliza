/**
 * Exercises billing-settings HTTP requests through the real session authority
 * and cookie guard, with deterministic primary-storage and service boundaries.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv, AuthedUser } from "@/types/cloud-worker-env";

let currentRole = "owner";
let cachedRole = "owner";
let currentTenant = "org-1";
let validSession = true;
let revokeDuringValidation = false;
let organizationAvailable = true;
const effects: Array<{ organizationId: string; settings: object }> = [];
const primaryReads = mock(async () => ({
  id: "user-1",
  role: currentRole,
  organization_id: currentTenant,
  organization: { id: currentTenant, name: "Organization", is_active: true },
  steward_user_id: "steward-1",
  is_active: true,
  is_anonymous: false,
  deleted_at: null,
  expires_at: null,
  email: "owner@example.test",
  wallet_address: null,
}));
class MockUnavailableError extends Error {}
mock.module("@/db/repositories/users", () => ({
  usersRepository: { findWithOrganizationForWrite: primaryReads },
}));
mock.module("@/lib/auth/steward-client", () => ({
  isStagingSessionTokenCandidate: () => false,
  verifyStewardTokenCached: async () =>
    validSession ? { userId: "steward-1" } : null,
}));
mock.module("@/lib/auth/staging-session-binding", () => ({
  loadVerifiedStagingSessionUser: async () => null,
}));
mock.module("@/lib/services/account-lifecycle-authority", () => ({
  readOrganizationLifecycleAuthority: async () => ({ state: "active" }),
  organizationLifecycleAllowsNewWork: () => true,
}));
mock.module("@/db/repositories", () => ({
  organizationsRepository: {
    findById: async (organizationId: string) =>
      organizationAvailable
        ? {
            id: organizationId,
            pay_as_you_go_from_earnings: false,
            stripe_customer_id: "must-not-leak",
            stripe_default_payment_method: "must-not-leak",
          }
        : undefined,
  },
}));
class ValidationError extends Error {}
class PolicyError extends Error {}
mock.module("@/lib/services/auto-top-up", () => ({
  AUTO_TOP_UP_LIMITS: {
    MIN_AMOUNT: 1,
    MAX_AMOUNT: 1000,
    MIN_THRESHOLD: 0,
    MAX_THRESHOLD: 1000,
  },
  AutoTopUpSettingsValidationError: ValidationError,
  AutoTopUpSettingsPolicyError: PolicyError,
  AutoTopUpSettingsUnavailableError: MockUnavailableError,
  autoTopUpService: {
    getSettings: async () => ({
      enabled: false,
      amount: 0,
      threshold: 0,
      hasPaymentMethod: false,
    }),
    updateSettings: async (
      organizationId: string,
      settings: object,
      authorize: () => Promise<void>,
    ) => {
      if (revokeDuringValidation) currentRole = "member";
      await authorize();
      effects.push({ organizationId, settings });
    },
  },
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
}));

const { default: route } = await import("./route");
const { cookieMutationGuardMiddleware } = await import(
  "../../../src/middleware/cookie-mutation-guard"
);
const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  const user: AuthedUser = {
    id: "user-1",
    organization_id: "org-1",
    organization: { id: "org-1", is_active: true },
    role: cachedRole,
    steward_id: "steward-1",
    is_active: true,
    is_anonymous: false,
  };
  c.set("user", user);
  c.set("authMethod", "session");
  await next();
});
app.use("*", cookieMutationGuardMiddleware);
app.route("/api/v1/billing/settings", route);
const url = "https://api.eliza.app/api/v1/billing/settings";
const request = (headers: Record<string, string> = {}) =>
  app.request(
    url,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie: "steward-token=fixture",
        origin: "https://api.eliza.app",
        host: "api.eliza.app",
        ...headers,
      },
      body: JSON.stringify({
        autoTopUp: { enabled: false },
        payAsYouGoFromEarnings: false,
        organizationId: "org-other",
      }),
    },
    {},
  );

beforeEach(() => {
  currentRole = "owner";
  cachedRole = "owner";
  currentTenant = "org-1";
  validSession = true;
  revokeDuringValidation = false;
  organizationAvailable = true;
  effects.length = 0;
  primaryReads.mockClear();
});

describe("billing settings current authority", () => {
  test("owner/admin manage only their authenticated organization after two primary checks", async () => {
    for (const role of ["owner", "admin"]) {
      currentRole = role;
      expect((await request()).status).toBe(200);
    }
    expect(effects.map((effect) => effect.organizationId)).toEqual([
      "org-1",
      "org-1",
    ]);
    expect(primaryReads).toHaveBeenCalledTimes(4);
  });
  test("member/guest and general API keys cannot reach persistence", async () => {
    for (const role of ["member", "guest"]) {
      currentRole = role;
      expect((await request()).status).toBe(403);
    }
    currentRole = "owner";
    expect((await request({ "x-api-key": "eliza_fixture" })).status).toBe(401);
    expect(
      (await request({ authorization: "Bearer eliza_fixture" })).status,
    ).toBe(401);
    expect(effects).toEqual([]);
  });
  test("stale membership and invalid session prevent effects", async () => {
    currentTenant = "org-other";
    expect((await request()).status).toBe(403);
    currentTenant = "org-1";
    validSession = false;
    expect((await request()).status).toBe(401);
    expect(effects).toEqual([]);
  });
  test("revocation during validation denies the final boundary", async () => {
    revokeDuringValidation = true;
    expect((await request()).status).toBe(403);
    expect(primaryReads).toHaveBeenCalledTimes(2);
    expect(effects).toEqual([]);
  });
  test("cross-origin and simple cookie mutations fail before primary authorization", async () => {
    expect(
      (await request({ origin: "https://untrusted.example" })).status,
    ).toBe(403);
    expect((await request({ "content-type": "text/plain" })).status).toBe(403);
    expect(primaryReads).not.toHaveBeenCalled();
    expect(effects).toEqual([]);
  });
  test("member reads remain uncached and do not disclose provider fields", async () => {
    currentRole = "member";
    cachedRole = "member";
    const response = await app.request(
      `${url}?organizationId=org-other`,
      {},
      {},
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("must-not-leak");
    expect(effects).toEqual([]);
  });
  test("missing organization is unavailable instead of a healthy default", async () => {
    organizationAvailable = false;
    const response = await app.request(url, {}, {});
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "service_unavailable",
    });
  });
});
