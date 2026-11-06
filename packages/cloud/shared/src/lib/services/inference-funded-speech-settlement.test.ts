import { expect, mock, test } from "bun:test";
import { runWithCloudBindings } from "../runtime/cloud-bindings";
import { admitFundedBudgetInference } from "./inference-funded-budget-admission";
import type { OrganizationInferenceAdmissionParams } from "./organization-inference-admission";

const events: string[] = [];
mock.module("../../db/repositories/inference-funding-budgets", () => ({
  recordConsumption: async () => {
    events.push("primary");
    return { replayed: events.filter((event) => event === "primary").length > 1 };
  },
}));

test("funded speech proof waits for primary persistence and retries a lost gate acknowledgment", async () => {
  const organizationId = "org";
  const requestId = "speech:test:tts";
  const receipt = { organizationId, requestId, amountMicros: "1000" };
  const rates = { completionsRpm: 60, embeddingsRpm: 60, standardRpm: 60, strictRpm: 60 };
  const params: OrganizationInferenceAdmissionParams = {
    context: {
      organizationId,
      requestId,
      userId: "user",
      provider: "cartesia",
      billingSource: "cartesia",
      model: "sonic-3",
    },
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    flatCost: { baseTotalCost: 0.008, totalCost: 0.01, platformMarkup: 0.002 },
    executionCtx: {
      waitUntil() {
        throw Error("Proof-mode settlement cannot finish in the background");
      },
    },
    credential: {
      kind: "api_key",
      credentialId: "key",
      userId: "user",
      rateLimit: 60,
      expiresAt: null,
    },
    admissionSnapshot: {
      fundedBudget: {
        organizationId,
        enabled: true,
        epoch: "1",
        policyGeneration: "1",
        validUntil: Date.now() + 60_000,
        rateLimits: rates,
      },
      authority: {
        generation: "1",
        source: "subscription",
        sourceSubscriptionId: "subscription",
        sourceRevision: "1",
        projectionRevision: "1",
        catalogVersion: null,
        effectiveFrom: new Date(0).toISOString(),
        effectiveUntil: null,
      },
      subscriptionFunded: true,
      balance: { balanceUsd: 1, balanceAt: Date.now(), balanceRevision: "1" },
      rateLimits: rates,
    },
    requireTerminalSettlementReceipt: true,
  };
  const gates = {
    getByName(name: string) {
      expect(name).toBe(organizationId);
      return {
        async fetch(request: Request) {
          const path = new URL(request.url).pathname;
          events.push(path);
          const body = (await request.json()) as Record<string, unknown>;
          if (path === "/budget/admit") return Response.json({ admitted: true });
          if (path === "/budget/complete") {
            expect(body).toMatchObject({ organizationId, requestId, amountMicros: "1000" });
            return Response.json({ receipt });
          }
          if (path === "/budget/acknowledge") {
            expect(events.at(-2)).toBe("primary");
            expect(body.receipt).toEqual(receipt);
            return Response.json({
              acknowledged: events.filter((event) => event === path).length === 2,
            });
          }
          throw Error("Unexpected gate call");
        },
      };
    },
  };
  const admission = await runWithCloudBindings({ INFERENCE_ADMISSION_GATES: gates }, () =>
    admitFundedBudgetInference(params),
  );
  await expect(admission.settle(0.001)).rejects.toThrow("acknowledgment is unknown");
  expect(() => admission.settle(0.002)).toThrow("replay changed its charge");
  expect((await admission.settle(0.001))?.terminalReceipt).toEqual({
    version: 1,
    status: "funded_persisted",
    mode: "durable_object_funded_budget",
    organizationId,
    requestId,
    amountUsd: "0.001000",
  });
  expect(events).toEqual([
    "/budget/admit",
    "/budget/complete",
    "primary",
    "/budget/acknowledge",
    "/budget/complete",
    "primary",
    "/budget/acknowledge",
  ]);
});
