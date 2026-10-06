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
const schedules = mock(async (_limit: number) => ({ inspected: 0 }));
mock.module(
  "@elizaos/cloud-shared/lib/services/organization-schedule-maintenance",
  () => ({ recoverOrganizationSchedules: schedules }),
);
const originalInvoices = mock(async () => ({
  status: "ok",
  attempts: [],
  deferredByBudget: 0,
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/original-invoice-maintenance",
  () => ({ recoverOriginalInvoiceObservations: originalInvoices }),
);
const adjustments = mock(async () => ({ status: "ok", attempts: [] }));
mock.module(
  "@elizaos/cloud-shared/lib/services/renewal-adjustment-maintenance",
  () => ({ recoverRenewalAdjustmentObservations: adjustments }),
);
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
mock.module("@elizaos/cloud-shared/lib/redis-queue", () => ({
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
  originalInvoices.mockReset();
  originalInvoices.mockImplementation(async () => ({
    status: "ok",
    attempts: [],
    deferredByBudget: 0,
  }));
  adjustments.mockReset();
  adjustments.mockImplementation(async () => ({ status: "ok", attempts: [] }));
  upgrades.mockReset();
  upgrades.mockImplementation(async () => ({
    inspected: 1,
    applied: 1,
    pending: 0,
    unavailable: 0,
    deferred: 0,
  }));
  cancellations.mockClear();
  schedules.mockReset();
  schedules.mockImplementation(async () => ({ inspected: 0 }));
});
afterAll(() => mock.restore());
test("cron authentication precedes every recovery lane", async () => {
  const response = await app.request("http://localhost/", { method: "POST" });
  expect(response.status).toBe(401);
  expect(upgrades).not.toHaveBeenCalled();
  expect(originalInvoices).not.toHaveBeenCalled();
  expect(cancellations).not.toHaveBeenCalled();
  expect(schedules).not.toHaveBeenCalled();
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
    originalInvoices: { status: "ok", attempts: [], deferredByBudget: 0 },
  });
  expect(upgrades).toHaveBeenCalledWith(5);
  expect(schedules).toHaveBeenCalledWith(5);
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

test("schedule infrastructure failure does not stop independent recovery lanes", async () => {
  schedules.mockImplementation(async () => {
    throw Error("journal unavailable");
  });
  const response = await app.request("http://localhost/", {
    method: "POST",
    headers: { authorization: "Bearer test-cron" },
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ failedLanes: ["schedules"] });
  expect(upgrades).toHaveBeenCalledTimes(1);
  expect(cancellations).toHaveBeenCalledTimes(1);
});

test("adjustment evidence failure is reported without stopping other maintenance", async () => {
  adjustments.mockImplementation(async () => {
    throw Error("observation database unavailable");
  });
  const response = await app.request("http://localhost/", {
    method: "POST",
    headers: { authorization: "Bearer test-cron" },
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ failedLanes: ["adjustments"] });
  expect(upgrades).toHaveBeenCalledTimes(1);
  expect(cancellations).toHaveBeenCalledTimes(1);
});
test("unauthenticated requests never start adjustment recovery", async () => {
  const response = await app.request("http://localhost/", { method: "POST" });
  expect(response.status).toBe(401);
  expect(adjustments).not.toHaveBeenCalled();
});

test("original invoice infrastructure failure remains visible while independent lanes execute", async () => {
  originalInvoices.mockImplementation(async () => {
    throw Error("invoice journal unavailable");
  });
  const response = await app.request("http://localhost/", {
    method: "POST",
    headers: { authorization: "Bearer test-cron" },
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    failedLanes: ["originalInvoices"],
  });
  expect(adjustments).toHaveBeenCalledTimes(1);
  expect(upgrades).toHaveBeenCalledTimes(1);
});
