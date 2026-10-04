/** The renewal preview has the same manager boundary as mutation, but accepts no provider IDs or mutation body. */
import { beforeEach, expect, mock, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { ApiError, ForbiddenError } from "@/lib/api/cloud-worker-errors";

const identity = {
  id: "5948f89f-3c52-40d5-ab3e-ce2d02e67c44",
  organization_id: "bc411333-ad64-473a-98e4-d55d31d66bb7",
};
const subscriptionId = "75a1e593-bd63-4bff-99f3-b916182bc30d";
const auth = mock(async () => identity);
const read = mock(async (_input: unknown, verify: () => Promise<void>) => {
  await verify();
  return { kind: "renewal_estimate" };
});
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireCurrentBillingManagerSession: auth,
}));
mock.module("@/lib/services/subscription-renewal-review", () => ({
  readOrganizationSubscriptionRenewalReview: read,
}));
const pass: MiddlewareHandler = async (_c, next) => {
  await next();
};
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  moneyRateLimit: () => pass,
  RateLimitPresets: { STANDARD: {} },
}));
const route = (await import("./route")).default;
const path = `/?subscriptionId=${subscriptionId}&expectedSubscriptionRevision=2`;
beforeEach(() => {
  auth.mockReset();
  auth.mockResolvedValue(identity);
  read.mockClear();
});

test("returns a no-store review with server-owned actor and organization", async () => {
  const response = await route.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(read.mock.calls[0]?.[0]).toEqual({
    subscriptionId,
    expectedSubscriptionRevision: 2,
    actorId: identity.id,
    organizationId: identity.organization_id,
  });
  expect(auth).toHaveBeenCalledTimes(2);
});
test("signed-out and non-manager authority cannot reach the review service", async () => {
  for (const error of [
    new ApiError(401, "authentication_required", "Sign in"),
    ForbiddenError("Manager required"),
  ]) {
    auth.mockRejectedValue(error);
    expect((await route.request(path)).status).toBe(error.status);
  }
  expect(read).not.toHaveBeenCalled();
});
test("rejects malformed/unsafe revisions and caller-supplied ownership", async () => {
  for (const query of [
    "expectedSubscriptionRevision=0",
    "expectedSubscriptionRevision=9007199254740992",
    "expectedSubscriptionRevision=02",
    "expectedSubscriptionRevision=2&customerId=cus_other",
    "expectedSubscriptionRevision=2&organizationId=other",
  ]) {
    expect(
      (await route.request(`/?subscriptionId=${subscriptionId}&${query}`))
        .status,
    ).toBe(400);
  }
  expect(read).not.toHaveBeenCalled();
});
test("a changed session during preview does not publish a result", async () => {
  auth
    .mockResolvedValueOnce(identity)
    .mockResolvedValueOnce({ ...identity, organization_id: subscriptionId });
  expect((await route.request(path)).status).toBe(403);
});
test("POST cannot turn review into a mutation", async () => {
  expect((await route.request(path, { method: "POST" })).status).toBe(404);
  expect(read).not.toHaveBeenCalled();
});
