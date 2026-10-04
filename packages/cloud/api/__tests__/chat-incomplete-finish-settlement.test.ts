/**
 * Drives the real /api/v1/chat route and AI SDK streamText with a mock
 * provider model. A stream that ends on an incomplete finish reason (length,
 * content filter) has already been delivered to the caller, so it must still
 * settle the admission hold at the reported usage and persist the turn.
 */
import { describe, expect, mock, test } from "bun:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

let finishReason: "stop" | "length" | "content-filter" = "stop";

function makeModel() {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "t" },
          {
            type: "text-delta",
            id: "t",
            delta: "partial answer that was delivered",
          },
          { type: "text-end", id: "t" },
          {
            type: "finish",
            finishReason: { unified: finishReason, raw: finishReason },
            usage: {
              inputTokens: {
                total: 1000,
                noCache: 1000,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 8000, text: 8000, reasoning: 0 },
            },
          },
        ],
      }),
    }),
  });
}

const settleCalls: Array<string> = [];
const billUsage = mock(
  async (
    _ctx: unknown,
    usage: { inputTokens?: number; outputTokens?: number },
  ) => {
    const totalCost =
      (usage.inputTokens ?? 0) * 0.000001 + (usage.outputTokens ?? 0) * 0.00001;
    return {
      inputCost: 0,
      outputCost: totalCost,
      totalCost,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
  },
);
const addMessage = mock(async () => ({}));
const usageCreate = mock(async () => ({ id: "u1" }));

const languageModelActual = await import("@/lib/providers/language-model");
mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  hasLanguageModelProviderConfigured: () => true,
  getLanguageModel: () => makeModel(),
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({
  getCurrentUser: async () => ({ id: "user-1", organization_id: "org-1" }),
}));
const rateLimitActual = await import("@/lib/middleware/rate-limit");
mock.module("@/lib/middleware/rate-limit", () => ({
  ...rateLimitActual,
  enforceOrgRateLimit: async () => null,
}));
mock.module("@/lib/services/content-moderation", () => ({
  contentModerationService: {
    shouldBlockUser: async () => false,
    moderateInBackground: () => Promise.resolve(),
  },
}));
const admissionActual = await import(
  "@/lib/services/organization-inference-admission"
);
mock.module("@/lib/services/organization-inference-admission", () => ({
  ...admissionActual,
  admitOrganizationInference: async () => ({
    settle: async (cost: number) => {
      settleCalls.push(`settle(${cost.toFixed(4)})`);
      return null;
    },
    settleUnknown: async () => {
      settleCalls.push("settleUnknown");
      return null;
    },
    markProviderDispatched: async () => {},
    reservation: undefined,
  }),
}));
const billingActual = await import("@/lib/services/ai-billing");
mock.module("@/lib/services/ai-billing", () => ({
  ...billingActual,
  billUsage,
}));
mock.module("@/lib/services/conversations", () => ({
  conversationsService: { addMessageWithSequence: addMessage },
}));
mock.module("@/lib/services/usage", () => ({
  usageService: { create: usageCreate },
}));

const { default: app } = await import("../v1/chat/route");

async function runTurn(reason: typeof finishReason) {
  finishReason = reason;
  settleCalls.length = 0;
  billUsage.mockClear();
  addMessage.mockClear();
  usageCreate.mockClear();
  const res = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [
        {
          role: "user",
          content: "hello",
          metadata: { conversationId: "conv-1" },
        },
      ],
    }),
  });
  const body = await res.text();
  await new Promise((r) => setTimeout(r, 50));
  return {
    status: res.status,
    deliveredText: body.includes("partial answer that was delivered"),
    settleCalls: [...settleCalls],
    billUsageCalls: billUsage.mock.calls.length,
    conversationWrites: addMessage.mock.calls.length,
    usageRecords: usageCreate.mock.calls.length,
  };
}

describe("/api/v1/chat terminal settlement for incomplete finish reasons", () => {
  test("baseline: finishReason=stop settles the hold to actual cost", async () => {
    const r = await runTurn("stop");
    expect(r.settleCalls).toEqual(["settle(0.0810)"]);
  });

  for (const reason of ["length", "content-filter"] as const) {
    test(`finishReason=${reason}: delivered output must still settle the hold`, async () => {
      const r = await runTurn(reason);
      expect(r.deliveredText).toBe(true);
      expect(r.settleCalls).toEqual(["settle(0.0810)"]);
      expect(r.billUsageCalls).toBe(1);
      expect(r.conversationWrites).toBe(2);
    });
  }
});
