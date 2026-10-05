/** Review route has current manager authority and exposes only the public quote projection. */
import { beforeEach, expect, mock, test } from "bun:test";
import {
  ApiError,
  ForbiddenError,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import type { MiddlewareHandler } from "hono";

const identity = {
  id: "5948f89f-3c52-40d5-ab3e-ce2d02e67c44",
  organization_id: "bc411333-ad64-473a-98e4-d55d31d66bb7",
};
const input = {
  subscriptionId: "75a1e593-bd63-4bff-99f3-b916182bc30d",
  expectedSubscriptionRevision: 2,
  targetPlanKey: "pro_monthly",
};
const auth = mock(async () => identity);
const create = mock(async (_input: unknown, verify: () => Promise<void>) => {
  await verify();
  return {
    id: "quote_fixture",
    review: { kind: "upgrade_estimate" },
    source_digest: "private",
    actor_id: "private",
    organization_id: "private",
  };
});
mock.module("@elizaos/cloud-shared/auth", () => ({
  requireCurrentBillingManagerSession: auth,
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/organization-upgrade-preview",
  () => ({ createOrganizationUpgradeQuote: create }),
);
const pass: MiddlewareHandler = async (_c, next) => {
  await next();
};
mock.module(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare",
  () => ({ moneyRateLimit: () => pass, RateLimitPresets: { STANDARD: {} } }),
);
const route = (await import("./route")).default;
function request(body: unknown = input) {
  return route.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  auth.mockReset();
  auth.mockResolvedValue(identity);
  create.mockClear();
});
test("server-owned actor and organization produce only a no-store public quote", async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(create.mock.calls[0]![0]).toEqual({
    ...input,
    actorId: identity.id,
    organizationId: identity.organization_id,
  });
  const responseBody: unknown = await response.json();
  expect(responseBody).toEqual({
    success: true,
    data: { quoteId: "quote_fixture", review: { kind: "upgrade_estimate" } },
  });
  expect(auth).toHaveBeenCalledTimes(2);
});
test("signed-out and non-manager requests cannot call provider review", async () => {
  for (const error of [
    new ApiError(401, "authentication_required", "Sign in"),
    ForbiddenError("Manager required"),
  ]) {
    auth.mockRejectedValue(error);
    expect((await request()).status).toBe(error.status);
  }
  expect(create).not.toHaveBeenCalled();
});
test("rejects ownership injection, unsafe revision and invented commercial terms", async () => {
  for (const body of [
    { ...input, organizationId: identity.organization_id },
    { ...input, actorId: identity.id },
    { ...input, customerId: "cus_other" },
    { ...input, expectedSubscriptionRevision: 9007199254740992 },
    { ...input, expectedSubscriptionRevision: 0 },
    { ...input, targetPlanKey: "invented" },
    { ...input, amountDueCents: 0 },
  ])
    expect((await request(body)).status).toBe(400);
  expect(create).not.toHaveBeenCalled();
});
test("changed manager session cannot publish review", async () => {
  auth.mockResolvedValueOnce(identity).mockResolvedValueOnce({
    ...identity,
    organization_id: input.subscriptionId,
  });
  expect((await request()).status).toBe(403);
});
test("malformed JSON is a client error and GET does not persist a quote", async () => {
  expect((await route.request("/", { method: "POST", body: "{" })).status).toBe(
    400,
  );
  expect((await route.request("/")).status).toBe(404);
  expect(create).not.toHaveBeenCalled();
});
test("provider errors are sanitized", async () => {
  create.mockRejectedValueOnce(
    Object.assign(new Error("private provider detail"), {
      code: "BILLING_PROVIDER_PREVIEW_SCOPE",
    }),
  );
  const response = await request();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private provider detail");
});
