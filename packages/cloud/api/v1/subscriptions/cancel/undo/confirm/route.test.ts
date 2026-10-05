/** Confirm requires an exact reviewed digest and keeps actor/provider ownership server-side. */
import { beforeEach, expect, mock, test } from "bun:test";
import { ApiError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import type { MiddlewareHandler } from "hono";

const identity = {
  id: "5948f89f-3c52-40d5-ab3e-ce2d02e67c44",
  organization_id: "bc411333-ad64-473a-98e4-d55d31d66bb7",
};
const input = {
  subscriptionId: "75a1e593-bd63-4bff-99f3-b916182bc30d",
  expectedSubscriptionRevision: 2,
  idempotencyKey: "reviewed-undo-test",
  expectedRenewalTermsDigest: "a".repeat(64),
};
const auth = mock(async () => identity);
let domainError: Error | null = null;
const submit = mock(async (_input: unknown, verify: () => Promise<void>) => {
  await verify();
  if (domainError) throw domainError;
  return { status: "APPLIED" };
});
mock.module("@elizaos/cloud-shared/auth", () => ({
  requireCurrentBillingManagerSession: auth,
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/subscription-cancellation",
  () => ({
    submitReviewedOrganizationSubscriptionCancellationUndo: submit,
  }),
);
const pass: MiddlewareHandler = async (_c, next) => {
  await next();
};
mock.module(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare",
  () => ({
    moneyRateLimit: () => pass,
    RateLimitPresets: { STANDARD: {} },
  }),
);
const route = (await import("./route")).default;
const post = (body: unknown) =>
  route.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  auth.mockReset();
  auth.mockResolvedValue(identity);
  submit.mockClear();
  domainError = null;
});
test("forwards the reviewed digest under current server identity", async () => {
  const response = await post(input);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(submit.mock.calls[0]?.[0]).toEqual({
    ...input,
    actorId: identity.id,
    organizationId: identity.organization_id,
  });
});
test("missing or malformed review and caller-supplied provider/ownership fields reject", async () => {
  for (const body of [
    { ...input, expectedRenewalTermsDigest: undefined },
    { ...input, expectedRenewalTermsDigest: "arbitrary" },
    { ...input, customerId: "cus_other" },
    { ...input, organizationId: identity.organization_id },
    { ...input, renewalReview: {} },
    { ...input, idempotencyKey: "short" },
    { ...input, idempotencyKey: "contains a space" },
  ]) {
    expect((await post(body)).status).toBe(400);
  }
  expect(submit).not.toHaveBeenCalled();
});
test("unauthorized or changed session cannot confirm", async () => {
  auth.mockRejectedValueOnce(
    new ApiError(401, "authentication_required", "Sign in"),
  );
  expect((await post(input)).status).toBe(401);
  expect(submit).not.toHaveBeenCalled();
  auth.mockResolvedValueOnce(identity).mockResolvedValueOnce({
    ...identity,
    organization_id: input.subscriptionId,
  });
  expect((await post(input)).status).toBe(403);
});
test("changed terms return a sanitized conflict and never provider details", async () => {
  domainError = Object.assign(new Error("private provider detail"), {
    code: "SUBSCRIPTION_RENEWAL_TERMS_CHANGED",
  });
  const response = await post(input);
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain("private provider detail");
});
