/** Proves prompt suggestions complete standing and credit admission before OpenAI dispatch. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiError } from "@/lib/api/cloud-worker-errors";
import * as organizationInferenceAdmissionActual from "@/lib/services/organization-inference-admission";

const order: string[] = [];
const waitUntilTasks: Promise<unknown>[] = [];
const requireGenerativeRouteCaller = mock(async () => {
  order.push("standing");
  return {
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: "key-1",
    admissionSnapshot: { balance: 10, revision: 2 },
  };
});
const markProviderDispatched = mock(async () => {
  order.push("mark-dispatched");
});
const settle = mock(async () => null);
const settleUnknown = mock(async () => null);
const admitOrganizationInference = mock(async () => {
  order.push("admission");
  return {
    mode: "durable_object_debit",
    reservation: { reconcile: async () => undefined },
    markProviderDispatched,
    settle,
    settleUnknown,
  };
});
const streamText = mock(() => {
  order.push("provider");
  return {
    usage: Promise.resolve({ inputTokens: 40, outputTokens: 20 }),
    toTextStreamResponse: () => new Response("[]", { status: 200 }),
  };
});
const billUsage = mock(async () => ({ totalCost: 0.002 }));

mock.module("@/api-app/lib/generative-route-auth", () => ({
  requireGenerativeRouteCaller,
  asGenerativeCacheApiError: () => null,
  getGenerativeExecutionContext: () => ({
    waitUntil: (promise: Promise<unknown>) => waitUntilTasks.push(promise),
  }),
}));
mock.module("@/lib/services/organization-inference-admission", () => ({
  ...organizationInferenceAdmissionActual,
  admitOrganizationInference,
}));
mock.module("@/lib/services/ai-billing", () => ({ billUsage }));
mock.module("@/lib/pricing", () => ({ estimateTokens: () => 100 }));
mock.module("@ai-sdk/openai", () => ({ openai: () => ({}) }));
mock.module("ai", () => ({ streamText }));
mock.module("@elizaos/core", () => ({
  assertModelOutputComplete: () => undefined,
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

const { default: app } = await import("./route");

describe("POST /api/v1/generate-prompts admission ordering", () => {
  beforeEach(() => {
    order.length = 0;
    waitUntilTasks.length = 0;
    requireGenerativeRouteCaller.mockClear();
    admitOrganizationInference.mockClear();
    markProviderDispatched.mockClear();
    streamText.mockClear();
    billUsage.mockClear();
    settle.mockClear();
    settleUnknown.mockClear();
  });

  test("admits before provider dispatch and settles off the response path", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seed: "deterministic" }),
    });

    expect(response.status).toBe(200);
    expect(order).toEqual([
      "standing",
      "admission",
      "mark-dispatched",
      "provider",
    ]);
    expect(waitUntilTasks).toHaveLength(1);
    await Promise.all(waitUntilTasks);
    expect(billUsage).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(0.002);
    expect(settleUnknown).not.toHaveBeenCalled();
  });

  test("standing denial stops before admission and provider dispatch", async () => {
    requireGenerativeRouteCaller.mockImplementationOnce(async () => {
      throw new ApiError(403, "access_denied", "Organization is inactive", {
        reason: "organization_inactive",
      });
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "access_denied",
      error: "Organization is inactive",
      details: { reason: "organization_inactive" },
    });
    expect(admitOrganizationInference).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
  });
});
