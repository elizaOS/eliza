/** Exercises real session-manager and cookie mutation boundaries with controlled primary membership and checkout-service collaborators. */
import { beforeEach, expect, mock, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, AuthedUser } from "@/types/cloud-worker-env";

const ORG = "10000000-0000-4000-8000-000000000001";
const SUB = "20000000-0000-4000-8000-000000000001";
const COMMAND = "30000000-0000-4000-8000-000000000001";
let role = "owner",
  tenant = ORG,
  session = true,
  revoke = false,
  failCode: string | null = null;
const effects: string[] = [];
const dto = {
  status: "open",
  commandId: COMMAND,
  checkoutUrl: "https://checkout.stripe.com/c/pay/fixture",
};
const primary = mock(async () => ({
  id: "user-1",
  role,
  organization_id: tenant,
  organization: { id: tenant, name: "Org", is_active: true },
  steward_user_id: "steward-1",
  is_active: true,
  is_anonymous: false,
  deleted_at: null,
  expires_at: null,
  email: "fixture@example.test",
  wallet_address: null,
}));
mock.module("@/db/repositories/users", () => ({
  usersRepository: { findWithOrganizationForWrite: primary },
}));
mock.module("@/lib/auth/steward-client", () => ({
  isStagingSessionTokenCandidate: () => false,
  verifyStewardTokenCached: async () =>
    session ? { userId: "steward-1" } : null,
}));
mock.module("@/lib/auth/staging-session-binding", () => ({
  loadVerifiedStagingSessionUser: async () => null,
}));
mock.module("@/lib/services/account-lifecycle-authority", () => ({
  readOrganizationLifecycleAuthority: async () => ({ state: "active" }),
  organizationLifecycleAllowsNewWork: () => true,
}));
mock.module("@/lib/services/subscription-checkout", () => ({
  submitSubscriptionCheckout: async (
    input: { organizationId: string; actorId: string },
    check: () => Promise<void>,
  ) => {
    if (revoke) role = "member";
    await check();
    if (failCode)
      throw new ElizaError("secret provider payload", { code: failCode });
    effects.push(input.organizationId);
    return dto;
  },
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
const { default: submit } = await import("./route");
const { cookieMutationGuardMiddleware } = await import(
  "../../../src/middleware/cookie-mutation-guard"
);
const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  const user: AuthedUser = {
    id: "user-1",
    organization_id: ORG,
    organization: { id: ORG, is_active: true },
    role: "owner",
    steward_id: "steward-1",
    is_active: true,
    is_anonymous: false,
  };
  c.set("user", user);
  c.set("authMethod", "session");
  await next();
});
app.use("*", cookieMutationGuardMiddleware);
app.route("/api/v1/subscriptions/checkout", submit);
const url = "https://api.eliza.app/api/v1/subscriptions/checkout";
function request(
  body: unknown = {
    planKey: "plus_monthly",
    idempotencyKey: SUB,
  },
  headers: Record<string, string> = {},
) {
  return app.request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: "steward-token=fixture",
      origin: "https://api.eliza.app",
      host: "api.eliza.app",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  role = "owner";
  tenant = ORG;
  session = true;
  revoke = false;
  failCode = null;
  effects.length = 0;
  primary.mockClear();
});
test("owner and admin start checkout only for their current session tenant", async () => {
  for (const value of ["owner", "admin"]) {
    role = value;
    const res = await request();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(
      z
        .object({ success: z.boolean(), data: z.unknown() })
        .parse(await res.json()),
    ).toEqual({ success: true, data: dto });
  }
  expect(effects).toEqual([ORG, ORG]);
  expect(primary).toHaveBeenCalledTimes(4);
});
test("member, API credentials, foreign origin and revoked session cannot reach effects", async () => {
  role = "member";
  expect((await request()).status).toBe(403);
  role = "owner";
  expect(
    (await request(undefined, { "X-API-Key": "eliza_fixture" })).status,
  ).toBe(401);
  expect(
    (await request(undefined, { origin: "https://foreign.invalid" })).status,
  ).toBe(403);
  session = false;
  expect((await request()).status).toBe(401);
  expect(effects).toEqual([]);
});
test("manager revocation during service validation is rechecked before effects", async () => {
  revoke = true;
  expect((await request()).status).toBe(403);
  expect(effects).toEqual([]);
  expect(primary).toHaveBeenCalledTimes(2);
});
test("tenant change and client supplied authority never reach effects", async () => {
  tenant = "10000000-0000-4000-8000-000000000002";
  expect((await request()).status).toBe(403);
  tenant = ORG;
  expect(
    (
      await request({
        planKey: "plus_monthly",
        idempotencyKey: SUB,
        organizationId: tenant,
      })
    ).status,
  ).toBe(400);
  expect(effects).toEqual([]);
});

test.each([
  ["SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT", 409],
  ["SUBSCRIPTION_CHECKOUT_UNAVAILABLE", 503],
] as const)("checkout %s hides provider details", async (code, status) => {
  failCode = code;
  const response = await request();
  expect(response.status).toBe(status);
  expect(await response.text()).not.toContain("secret");
});
