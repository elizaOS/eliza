import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const calls: unknown[][] = [];
let scope: string | null = null;
mock.module("@elizaos/cloud-shared/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: async () => {
    throw new Error("Unexpected GET auth");
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/app-promotion", () => ({
  appPromotionService: {
    promoteApp: async (...args: unknown[]) => {
      calls.push(args);
      return { success: true, errors: [], totalCreditsUsed: 0 };
    },
  },
}));
mock.module("@/api-app/lib/generative-route-auth", () => ({
  requireGenerativeRouteCaller: async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    appScopeId: scope,
    credential: {},
  }),
  getGenerativeOperationContext: () => ({}),
  asGenerativeCacheApiError: () => null,
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/deferred-credential-admission-guard",
  () => ({
    deferredCredentialAdmissionGuard: () => ({
      credentialForAdmission: async () => ({}),
      [Symbol.asyncDispose]: async () => {},
    }),
  }),
);
const { default: route } = await import("./route");
const app = new Hono().route("/apps/:id/promote", route);
afterAll(() => mock.restore());
beforeEach(() => {
  calls.length = 0;
  scope = null;
});
const advertising = {
  platform: "meta",
  adAccountId: "11111111-1111-4111-8111-111111111111",
  budget: 10,
  budgetType: "daily",
  objective: "traffic",
};
function post(extra: Record<string, unknown>) {
  return app.request("/apps/app-1/promote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channels: ["advertising"],
      advertising: { ...advertising, ...extra },
    }),
  });
}
test("the real route passes selected bid controls through schema parsing to promotion", async () => {
  const response = await post({
    bidStrategy: "cpc",
    optimizationGoal: "clicks",
  });
  expect(response.status).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls[0].slice(0, 3)).toEqual(["org-1", "user-1", "app-1"]);
  expect(calls[0][3]).toEqual({
    channels: ["advertising"],
    advertising: {
      ...advertising,
      bidStrategy: "cpc",
      optimizationGoal: "clicks",
    },
  });
});
test("invalid controls are rejected before promotion", async () => {
  expect((await post({ bidStrategy: "invalid" })).status).toBe(400);
  expect((await post({ optimizationGoal: "invalid" })).status).toBe(400);
  expect(calls).toHaveLength(0);
});
test("app-scoped credentials cannot promote another app", async () => {
  scope = "another-app";
  expect((await post({ bidStrategy: "cpc" })).status).toBe(403);
  expect(calls).toHaveLength(0);
});
