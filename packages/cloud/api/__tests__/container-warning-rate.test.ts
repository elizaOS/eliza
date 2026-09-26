import { afterAll, expect, mock, test } from "bun:test";
import type { Context } from "hono";
import { calculateDailyContainerCost } from "@/lib/constants/pricing";

const sent: Array<{
  dailyCost: number;
  monthlyCost: number;
  requiredCredits: number;
  minimumRecommended: number;
}> = [];
const resources = { desiredCount: 2, cpu: 2048, memory: 4096 };
mock.module("@/lib/auth/workers-hono-auth", () => ({ requireCronSecret() {} }));
mock.module("@/db/repositories", () => ({
  usersRepository: { listByOrganization: async () => [] },
}));
mock.module("@/db/repositories/container-billing", () => ({
  containerBillingRepository: {
    listBillableContainers: async (now: Date) => [
      {
        id: "container",
        organization_id: "org",
        name: "scaled worker",
        project_name: "project",
        desired_count: resources.desiredCount,
        cpu: resources.cpu,
        memory: resources.memory,
        billing_status: "active",
        last_billed_at: new Date(now.getTime() - 12 * 60 * 60 * 1000),
      },
    ],
    listBillingOrganizations: async () => [
      {
        id: "org",
        name: "Org",
        billing_email: "fixture@example.com",
        credit_balance: "0",
        pay_as_you_go_from_earnings: false,
      },
    ],
    scheduleShutdownWarning: async () => true,
    recordBillingFailure: async () => {},
  },
}));
mock.module("@/lib/services/container-stop-job-service", () => ({
  listRecoverableContainerStopIntents: async () => [],
  enqueueContainerStopOnce: async () => {
    throw new Error("No stop expected");
  },
  rearmRecoverableContainerStopIntentOnce: async () => {
    throw new Error("No recovery expected");
  },
}));
mock.module("@/lib/services/email", () => ({
  emailService: {
    sendContainerShutdownWarningEmail: async (mail: (typeof sent)[number]) => {
      sent.push(mail);
    },
  },
}));
mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {},
}));
mock.module("@/lib/services/redeemable-earnings", () => ({
  redeemableEarningsService: {},
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: Context, error: Error) =>
    c.json({ error: error.message }, 500),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { info() {}, error() {}, warn() {} },
}));
const { default: route } = await import("../cron/container-billing/route");
afterAll(() => mock.restore());

test("shutdown mail displays the actual full daily rate while preserving the prorated shortfall", async () => {
  const response = await route.request("/", {}, {});
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body).toMatchObject({
    data: { warningsSent: 1, errors: 0, containersBilled: 0 },
  });
  expect(sent).toHaveLength(1);
  const daily = calculateDailyContainerCost(resources);
  expect(sent[0]).toMatchObject({
    dailyCost: daily,
    monthlyCost: Math.round(daily * 30 * 100) / 100,
    requiredCredits: daily / 2,
    minimumRecommended: Math.round(daily * 7 * 100) / 100,
  });
  expect(sent[0].dailyCost).not.toBe(sent[0].requiredCredits);
});
