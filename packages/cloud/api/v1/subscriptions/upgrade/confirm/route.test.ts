/** Public original-command HTTP boundary; financial behavior is covered in PostgreSQL suites. */
import { beforeEach, expect, mock, test } from "bun:test";
import { ApiError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { Hono, type MiddlewareHandler } from "hono";

const identity = {
  id: "5948f89f-3c52-40d5-ab3e-ce2d02e67c44",
  organization_id: "bc411333-ad64-473a-98e4-d55d31d66bb7",
};
const commandId = "75a1e593-bd63-4bff-99f3-b916182bc30d";
const input = { quoteId: commandId, idempotencyKey: "original-quote-test" };
const auth = mock(async () => identity);
let domainError: Error | null = null;
const submit = mock(async (_input: unknown, verify: () => Promise<void>) => {
  await verify();
  if (domainError) throw domainError;
  return { commandId, status: "OUTCOME_UNKNOWN" };
});
const read = mock(async (_input: unknown, verify: () => Promise<void>) => {
  await verify();
  if (domainError) throw domainError;
  return { commandId, status: "APPLIED" };
});
const resume = mock(async (_input: unknown, verify: () => Promise<void>) => {
  await verify();
  if (domainError) throw domainError;
  return {
    command: { commandId, status: "OUTCOME_UNKNOWN" },
    continuation: {
      kind: "hosted_invoice",
      hostedInvoiceUrl: "https://invoice.stripe.com/i/test_private",
    },
  };
});
mock.module(
  "@elizaos/cloud-shared/lib/services/organization-upgrade-payment",
  () => ({
    continueOrganizationSubscriptionUpgradePayment: resume,
  }),
);
mock.module("@elizaos/cloud-shared/auth", () => ({
  requireCurrentBillingManagerSession: auth,
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/organization-upgrade-command",
  () => ({
    confirmOrganizationSubscriptionUpgrade: submit,
    readOrganizationSubscriptionUpgrade: read,
  }),
);
const pass: MiddlewareHandler = async (_c, next) => {
  await next();
};
mock.module(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare",
  () => ({
    moneyRateLimit: () => pass,
    rateLimit: () => pass,
    RateLimitPresets: { STANDARD: {} },
  }),
);
const confirm = (await import("./route")).default;
const status = new Hono().route(
  "/:commandId",
  (await import("../[commandId]/route")).default,
);
const payment = new Hono().route(
  "/:commandId/payment",
  (await import("../[commandId]/payment/route")).default,
);
const post = (body: unknown) =>
  confirm.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  auth.mockReset();
  auth.mockResolvedValue(identity);
  submit.mockClear();
  read.mockClear();
  resume.mockClear();
  domainError = null;
});
test("confirmation binds the original quote to authenticated identity and no-store", async () => {
  const result = await post(input);
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(submit.mock.calls[0]?.[0]).toEqual({
    ...input,
    organizationId: identity.organization_id,
    actorId: identity.id,
  });
  expect(await result.json()).toMatchObject({
    data: { status: "OUTCOME_UNKNOWN" },
  });
});
test("missing review, malformed JSON and caller-supplied financial authority reject", async () => {
  for (const body of [
    { ...input, quoteId: undefined },
    { ...input, quoteId: "bad" },
    { ...input, idempotencyKey: "short" },
    { ...input, organizationId: identity.organization_id },
    { ...input, amount: 1 },
    { ...input, paymentIntent: "pi_other" },
  ])
    expect((await post(body)).status).toBe(400);
  expect(
    (await confirm.request("/", { method: "POST", body: "{" })).status,
  ).toBe(400);
  expect(submit).not.toHaveBeenCalled();
});
test("status validates the command and current identity without dispatch", async () => {
  const response = await status.request(`/${commandId}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(read.mock.calls[0]?.[0]).toEqual({
    commandId,
    organizationId: identity.organization_id,
    actorId: identity.id,
  });
  expect(submit).not.toHaveBeenCalled();
  expect((await status.request("/bad")).status).toBe(400);
});
test("initial and changed session authority reject both routes", async () => {
  auth.mockRejectedValueOnce(
    new ApiError(401, "authentication_required", "Sign in"),
  );
  expect((await post(input)).status).toBe(401);
  expect(submit).not.toHaveBeenCalled();
  auth
    .mockResolvedValueOnce(identity)
    .mockResolvedValueOnce({ ...identity, organization_id: commandId });
  expect((await post(input)).status).toBe(403);
  auth
    .mockResolvedValueOnce(identity)
    .mockResolvedValueOnce({ ...identity, id: commandId });
  expect((await status.request(`/${commandId}`)).status).toBe(403);
});
for (const [code, expected] of [
  ["SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN", 403],
  ["SUBSCRIPTION_PLAN_CHANGE_CONFLICT", 409],
  ["SUBSCRIPTION_UPGRADE_NOT_FOUND", 404],
  ["SUBSCRIPTION_UPGRADE_STATUS_UNAVAILABLE", 503],
] as const)
  test(`sanitizes ${code}`, async () => {
    domainError = Object.assign(new Error("private provider payload"), {
      code,
    });
    const response = await post(input);
    expect(response.status).toBe(expected);
    expect(await response.text()).not.toContain("private provider payload");
  });

test("payment continuation binds current identity and is never cacheable", async () => {
  const response = await payment.request(`/${commandId}/payment`, {
    method: "POST",
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(resume.mock.calls[0]?.[0]).toEqual({
    commandId,
    organizationId: identity.organization_id,
    actorId: identity.id,
  });
  expect(submit).not.toHaveBeenCalled();
  expect(
    (await payment.request("/bad/payment", { method: "POST" })).status,
  ).toBe(400);
});
test("payment continuation revalidates the session and sanitizes unavailable provider state", async () => {
  auth
    .mockResolvedValueOnce(identity)
    .mockResolvedValueOnce({ ...identity, id: commandId });
  expect(
    (await payment.request(`/${commandId}/payment`, { method: "POST" })).status,
  ).toBe(403);
  domainError = Object.assign(
    new Error("https://invoice.stripe.com/i/private_provider_error"),
    { code: "SUBSCRIPTION_UPGRADE_PAYMENT_UNAVAILABLE" },
  );
  const response = await payment.request(`/${commandId}/payment`, {
    method: "POST",
  });
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).not.toContain("private_provider_error");
});
