/** Exercises real session-manager and cookie mutation boundaries with controlled primary membership and cancellation-service collaborators. */
import { beforeEach, expect, mock, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import { Hono } from "hono";
import { z } from "zod";
import type { OrganizationSubscriptionCancellationDto } from "@/lib/types/cloud-api";
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
const dto: OrganizationSubscriptionCancellationDto = {
  commandId: COMMAND,
  subscriptionId: SUB,
  status: "OUTCOME_UNKNOWN",
  expectedSubscriptionRevision: "1",
  resultSubscriptionRevision: null,
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
mock.module("@/lib/services/subscription-cancellation", () => ({
  submitOrganizationSubscriptionCancellation: async (
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
  readOrganizationSubscriptionCancellation: async (input: {
    organizationId: string;
    commandId: string;
  }) => {
    if (input.organizationId !== ORG || input.commandId !== COMMAND)
      throw new ElizaError("secret tenant command", {
        code: "SUBSCRIPTION_CANCELLATION_NOT_FOUND",
      });
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
const { default: poll } = await import("./[commandId]/route");
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
app.route("/api/v1/subscriptions/cancel", submit);
app.route("/api/v1/subscriptions/cancel/:commandId", poll);
const url = "https://api.eliza.app/api/v1/subscriptions/cancel";
function request(
  body: unknown = {
    subscriptionId: SUB,
    expectedSubscriptionRevision: 1,
    idempotencyKey: "request-1",
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
test("owner and admin use only the current session tenant and retain unknown outcome", async () => {
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
        subscriptionId: SUB,
        expectedSubscriptionRevision: 1,
        idempotencyKey: "request-1",
        organizationId: tenant,
      })
    ).status,
  ).toBe(400);
  expect(effects).toEqual([]);
});
test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "invalid revision %p cannot reach effects",
  async (revision) => {
    expect(
      (
        await request({
          subscriptionId: SUB,
          expectedSubscriptionRevision: revision,
          idempotencyKey: "request-1",
        })
      ).status,
    ).toBe(400);
    expect(effects).toEqual([]);
  },
);
test.each(["", " ", "x".repeat(201)])(
  "invalid request key is rejected",
  async (key) => {
    expect(
      (
        await request({
          subscriptionId: SUB,
          expectedSubscriptionRevision: 1,
          idempotencyKey: key,
        })
      ).status,
    ).toBe(400);
    expect(effects).toEqual([]);
  },
);
test.each([
  ["SUBSCRIPTION_CANCELLATION_FORBIDDEN", 403],
  ["SUBSCRIPTION_CANCELLATION_NOT_FOUND", 404],
  ["SUBSCRIPTION_CANCELLATION_CONFLICT", 409],
  ["SUBSCRIPTION_CANCELLATION_REOBSERVE", 503],
] as const)("domain %s is sanitized", async (code, status) => {
  failCode = code;
  const res = await request();
  expect(res.status).toBe(status);
  expect(await res.text()).not.toContain("secret");
});
test("polling rechecks current manager and returns only safe command fields", async () => {
  const res = await app.request(`${url}/${COMMAND}`, {
    headers: { cookie: "steward-token=fixture" },
  });
  expect(res.status).toBe(200);
  expect(
    z
      .object({ success: z.boolean(), data: z.unknown() })
      .parse(await res.json()),
  ).toEqual({ success: true, data: dto });
  role = "member";
  expect(
    (
      await app.request(`${url}/${COMMAND}`, {
        headers: { cookie: "steward-token=fixture" },
      })
    ).status,
  ).toBe(403);
  expect(effects).toEqual([]);
});
