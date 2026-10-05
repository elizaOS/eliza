/** Route wiring and independent maintenance failure behavior; repository suites own persisted authority. */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { Context } from "hono";

const upgrades = mock(async (_limit: number) => ({
  inspected: 1,
  applied: 1,
  pending: 0,
  unavailable: 0,
  deferred: 0,
}));
const cancellations = mock(async () => ({ inspected: 0 }));
mock.module("@elizaos/cloud-shared/auth", () => ({
  requireCronSecret: (c: Context) => {
    if (c.req.header("authorization") !== "Bearer test-cron")
      throw new Error("unauthorized");
  },
}));
mock.module("@elizaos/cloud-shared/db/repositories/webhook-events", () => ({
  webhookEventsRepository: { deleteByEventId: async () => {} },
}));
mock.module("@elizaos/cloud-shared/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: Context) => c.json({ success: false }, 401),
}));
mock.module("@elizaos/cloud-shared/lib/queue/redis-queue", () => ({
  queueLength: async () => 0,
  drain: async () => ({ processed: 0 }),
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/organization-upgrade-maintenance",
  () => ({ recoverOrganizationUpgrades: upgrades }),
);
mock.module(
  "@elizaos/cloud-shared/lib/services/subscription-cancellation",
  () => ({ recoverOrganizationSubscriptionCancellations: cancellations }),
);
mock.module("@elizaos/cloud-shared/lib/services/subscription-checkout", () => ({
  recoverStaleSubscriptionCheckouts: async () => ({ inspected: 0 }),
}));
mock.module("@elizaos/cloud-shared/lib/services/subscription-notices", () => ({
  sweepSubscriptionNotices: async () => ({ sent: 0 }),
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/subscription-reconciliation",
  () => ({ recoverMissedSubscriptionEvents: async () => ({ status: "ok" }) }),
);
mock.module("@elizaos/cloud-shared/lib/utils/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));
mock.module("@/api-queue/stripe-event", () => ({
  processStripeEvent: async () => "ack",
}));
const { default: app } = await import("./route");
beforeEach(() => {
  upgrades.mockReset();
  upgrades.mockImplementation(async () => ({
    inspected: 1,
    applied: 1,
    pending: 0,
    unavailable: 0,
    deferred: 0,
  }));
  cancellations.mockClear();
});
afterAll(() => mock.restore());
test("cron authentication precedes every recovery lane", async () => {
  const response = await app.request("http://localhost/", { method: "POST" });
  expect(response.status).toBe(401);
  expect(upgrades).not.toHaveBeenCalled();
  expect(cancellations).not.toHaveBeenCalled();
});
test("authenticated maintenance includes the upgrade recovery result", async () => {
  const response = await app.request("http://localhost/", {
    method: "POST",
    headers: { authorization: "Bearer test-cron" },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    success: true,
    upgrades: { applied: 1 },
  });
  expect(upgrades).toHaveBeenCalledWith(5);
});
test("upgrade infrastructure failure is visible while independent lanes still execute", async () => {
  upgrades.mockImplementation(async () => {
    throw new Error("journal unavailable");
  });
  const response = await app.request("http://localhost/", {
    method: "POST",
    headers: { authorization: "Bearer test-cron" },
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    success: false,
    failedLanes: ["upgrades"],
  });
  expect(cancellations).toHaveBeenCalledTimes(1);
});
