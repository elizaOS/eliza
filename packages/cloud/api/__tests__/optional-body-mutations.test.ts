/**
 * Exercises authenticated optional-body mutation routes through their real
 * Hono handlers, with deterministic authentication and mutation ledgers.
 */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const USER = { id: "user-1", organization_id: "org-1" };
const AGENT = {
  id: "agent-1",
  organization_id: USER.organization_id,
  user_id: USER.id,
  status: "running",
};

const calls = {
  suspend: [] as unknown[],
  deploy: [] as unknown[],
  duplicate: [] as unknown[],
  share: [] as unknown[],
  approvalCancel: [] as unknown[],
  ballotCancel: [] as unknown[],
  oauthCancel: [] as unknown[],
  paymentCancel: [] as unknown[],
  gatewayShutdown: [] as unknown[],
};

mock.module("@/lib/auth/service-key-hono-worker", () => ({
  requireServiceKey: async () => {},
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => USER,
}));
mock.module("../compat/_lib/auth", () => ({
  requireCompatAuth: async () => ({ user: USER, authMethod: "standard" }),
}));
mock.module("../internal/_auth", () => ({
  requireInternalAuth: async () => ({
    podName: "gateway-pod",
    service: "gateway-discord",
  }),
}));
mock.module("@/lib/auth/app-key-scope", () => ({
  isAppKeyOutOfScope: async () => false,
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));
mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: {
    getAgentById: async () => AGENT,
    getAgentForWrite: async () => AGENT,
  },
}));
mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentSuspendOnce: async (input: unknown) => {
      calls.suspend.push(input);
      return {
        created: true,
        job: { id: "job-1", status: "queued" },
      };
    },
    triggerImmediate: async () => {},
  },
}));
mock.module("@/api-app/lib/apps-deploy-gate", () => ({
  appsDeployOrganizationDecision: () => ({ allowed: true }),
}));
mock.module("@/db/repositories/containers", () => ({
  containersRepository: {
    checkQuota: async () => ({ allowed: true }),
  },
}));
mock.module("@/lib/services/apps", () => ({
  appsService: {
    getById: async () => ({
      id: "app-1",
      organization_id: USER.organization_id,
    }),
  },
}));
mock.module("@/lib/services/app-deployments", () => ({
  appDeploymentsService: {
    createDeployment: async (input: unknown) => {
      calls.deploy.push(input);
      return {
        deploymentId: "deployment-1",
        status: "queued",
        startedAt: "2026-10-03T00:00:00.000Z",
      };
    },
  },
}));
mock.module("@/lib/services/advertising", () => ({
  advertisingService: {
    duplicateCampaign: async (...input: unknown[]) => {
      calls.duplicate.push(input);
      return {
        campaign: {
          id: "campaign-copy",
          name: "Copy",
          platform: "meta",
          objective: "traffic",
          status: "draft",
          budget_type: "daily",
          budget_amount: "10",
          budget_currency: "USD",
          credits_allocated: "0",
          external_campaign_id: null,
          metadata: {},
          created_at: new Date("2026-10-03T00:00:00.000Z"),
        },
        creativesCopied: 0,
      };
    },
    createCampaignReportShare: async (input: unknown) => {
      calls.share.push(input);
      return {
        id: "share-1",
        campaignId: "campaign-1",
        token: "share-token",
        publicPath: "/reports/share-token",
        expiresAt: new Date("2026-10-10T00:00:00.000Z"),
      };
    },
  },
}));
mock.module("@/db/repositories/approval-requests", () => ({
  approvalRequestsRepository: {},
}));
mock.module("@/lib/services/approval-requests", () => ({
  createApprovalRequestsService: () => ({
    cancel: async (...input: unknown[]) => {
      calls.approvalCancel.push(input);
      return { id: "approval-1", status: "canceled" };
    },
  }),
}));
mock.module("@/lib/services/approval-callback-bus", () => ({
  approvalCallbackBus: { publish: async () => {} },
}));
mock.module("@/db/repositories/secret-ballots", () => ({
  secretBallotsRepository: {},
}));
mock.module("@/lib/services/secret-ballots", () => ({
  createSecretBallotsService: () => ({
    cancel: async (input: unknown) => {
      calls.ballotCancel.push(input);
      return { id: "ballot-1", status: "canceled" };
    },
  }),
}));
mock.module("@/lib/services/oauth-intents-default", () => ({
  getOAuthIntentsService: () => ({
    cancel: async (...input: unknown[]) => {
      calls.oauthCancel.push(input);
      return { id: "oauth-1", status: "canceled" };
    },
  }),
}));
mock.module("@/lib/services/oauth-intents", () => ({
  redactOAuthIntentForPublic: (value: unknown) => value,
}));
mock.module("@/lib/services/payment-requests-default", () => ({
  getPaymentRequestsService: () => ({
    cancel: async (...input: unknown[]) => {
      calls.paymentCancel.push(input);
      return { id: "payment-1", status: "canceled" };
    },
  }),
}));
mock.module("@/lib/services/payment-requests", () => ({
  toPaymentRequestDto: (value: unknown) => value,
}));
mock.module("@/db/repositories/discord-connections", () => ({
  discordConnectionsRepository: {
    clearPodAssignments: async (podName: string) => {
      calls.gatewayShutdown.push(podName);
      return 1;
    },
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

const { default: serviceSuspendRoute } = await import(
  "../v1/agents/[agentId]/suspend/route"
);
const { default: compatSuspendRoute } = await import(
  "../compat/agents/[id]/suspend/route"
);
const { default: deployRoute } = await import("../v1/apps/[id]/deploy/route");
const { default: duplicateRoute } = await import(
  "../v1/advertising/campaigns/[id]/duplicate/route"
);
const { default: shareRoute } = await import(
  "../v1/advertising/campaigns/[id]/report/share/route"
);
const { default: approvalCancelRoute } = await import(
  "../v1/approval-requests/[id]/cancel/route"
);
const { default: ballotCancelRoute } = await import(
  "../v1/ballots/[id]/cancel/route"
);
const { default: oauthCancelRoute } = await import(
  "../v1/oauth-intents/[id]/cancel/route"
);
const { default: paymentCancelRoute } = await import(
  "../v1/payment-requests/[id]/cancel/route"
);
const { default: gatewayShutdownRoute } = await import(
  "../internal/discord/gateway/shutdown/route"
);

afterAll(() => mock.restore());

beforeEach(() => {
  for (const ledger of Object.values(calls)) ledger.length = 0;
});

function mounted(route: Hono<AppEnv>, path: string): Hono<AppEnv> {
  return new Hono<AppEnv>().route(path, route);
}

type MutationCase = {
  label: string;
  route: Hono<AppEnv>;
  path: string;
  expectedStatus: number;
  ledger: unknown[];
  env?: Record<string, unknown>;
  headers?: Record<string, string>;
};

const mutationCases: MutationCase[] = [
  {
    label: "service agent suspension",
    route: mounted(serviceSuspendRoute, "/v1/agents/:agentId/suspend"),
    path: "/v1/agents/agent-1/suspend",
    expectedStatus: 202,
    ledger: calls.suspend,
  },
  {
    label: "compat agent suspension",
    route: mounted(compatSuspendRoute, "/compat/agents/:id/suspend"),
    path: "/compat/agents/agent-1/suspend",
    expectedStatus: 202,
    ledger: calls.suspend,
  },
  {
    label: "app deployment",
    route: mounted(deployRoute, "/v1/apps/:id/deploy"),
    path: "/v1/apps/app-1/deploy",
    expectedStatus: 202,
    ledger: calls.deploy,
    env: { APPS_DEPLOY_ENABLED: "1" },
  },
  {
    label: "campaign duplication",
    route: mounted(duplicateRoute, "/v1/advertising/campaigns/:id/duplicate"),
    path: "/v1/advertising/campaigns/campaign-1/duplicate",
    expectedStatus: 201,
    ledger: calls.duplicate,
  },
  {
    label: "campaign report sharing",
    route: mounted(shareRoute, "/v1/advertising/campaigns/:id/report/share"),
    path: "/v1/advertising/campaigns/campaign-1/report/share",
    expectedStatus: 201,
    ledger: calls.share,
  },
  {
    label: "approval cancellation",
    route: mounted(approvalCancelRoute, "/v1/approval-requests/:id/cancel"),
    path: "/v1/approval-requests/00000000-0000-4000-8000-000000000001/cancel",
    expectedStatus: 200,
    ledger: calls.approvalCancel,
  },
  {
    label: "ballot cancellation",
    route: mounted(ballotCancelRoute, "/v1/ballots/:id/cancel"),
    path: "/v1/ballots/00000000-0000-4000-8000-000000000002/cancel",
    expectedStatus: 200,
    ledger: calls.ballotCancel,
  },
  {
    label: "OAuth-intent cancellation",
    route: mounted(oauthCancelRoute, "/v1/oauth-intents/:id/cancel"),
    path: "/v1/oauth-intents/oauth-1/cancel",
    expectedStatus: 200,
    ledger: calls.oauthCancel,
  },
  {
    label: "payment-request cancellation",
    route: mounted(paymentCancelRoute, "/v1/payment-requests/:id/cancel"),
    path: "/v1/payment-requests/payment-1/cancel",
    expectedStatus: 200,
    ledger: calls.paymentCancel,
  },
  {
    label: "Discord gateway shutdown",
    route: mounted(gatewayShutdownRoute, "/internal/discord/gateway/shutdown"),
    path: "/internal/discord/gateway/shutdown",
    expectedStatus: 200,
    ledger: calls.gatewayShutdown,
  },
];

async function post(testCase: MutationCase, body?: string): Promise<Response> {
  return testCase.route.request(
    testCase.path,
    {
      method: "POST",
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...testCase.headers,
      },
      ...(body !== undefined ? { body } : {}),
    },
    testCase.env,
  );
}

test.each(mutationCases)(
  "$label rejects malformed non-empty JSON before mutation",
  async (testCase) => {
    const response = await post(testCase, "{");

    expect(response.status).toBe(400);
    expect(testCase.ledger).toHaveLength(0);
  },
);

test.each(mutationCases)(
  "$label preserves its bodyless mutation contract",
  async (testCase) => {
    const response = await post(testCase);

    expect(response.status).toBe(testCase.expectedStatus);
    expect(testCase.ledger).toHaveLength(1);
  },
);

test.each([mutationCases[0], mutationCases[1]])(
  "$label rejects a schema-invalid reason before mutation",
  async (testCase) => {
    const response = await post(testCase, JSON.stringify({ reason: 123 }));

    expect(response.status).toBe(400);
    expect(testCase.ledger).toHaveLength(0);
  },
);

test("whitespace-only and explicit empty-object bodies retain the optional-body contract", async () => {
  const payment = mutationCases[8];

  expect((await post(payment, "  \n\t")).status).toBe(200);
  expect((await post(payment, "{}")).status).toBe(200);
  expect(payment.ledger).toHaveLength(2);
});
