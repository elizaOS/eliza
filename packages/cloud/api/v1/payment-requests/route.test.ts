// Exercises payment-request agent ownership at the authenticated API boundary.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-a",
  organization_id: "org-a",
}));
const getAgentForWrite = mock(
  async (): Promise<{ id: string; organization_id: string } | undefined> => ({
    id: "agent-a",
    organization_id: "org-a",
  }),
);
const createPaymentRequest = mock(async (input: Record<string, unknown>) => ({
  paymentRequest: {
    id: "payment-request-a",
    organizationId: input.organizationId,
    agentId: input.agentId,
  },
  hostedUrl: "https://pay.example/request-a",
}));
const listPaymentRequests = mock(async () => []);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: { getAgentForWrite },
}));

mock.module("@/lib/services/payment-requests-default", () => ({
  getPaymentRequestsService: () => ({
    create: createPaymentRequest,
    list: listPaymentRequests,
  }),
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
  },
}));

const { default: paymentRequestsRoute } = await import("./route");
const app = new Hono();
app.route("/api/v1/payment-requests", paymentRequestsRoute);

function createRequest(agentId: string): Request {
  return new Request("https://api.example.test/api/v1/payment-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "oxapay",
      amountCents: 100,
      paymentContext: "any_payer",
      agentId,
    }),
  });
}

describe("POST /api/v1/payment-requests agent ownership", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockReset();
    requireUserOrApiKeyWithOrg.mockResolvedValue({ id: "user-a", organization_id: "org-a" });
    getAgentForWrite.mockReset();
    getAgentForWrite.mockResolvedValue({ id: "agent-a", organization_id: "org-a" });
    createPaymentRequest.mockReset();
    createPaymentRequest.mockResolvedValue({
      paymentRequest: {
        id: "payment-request-a",
        organizationId: "org-a",
        agentId: "agent-a",
      },
      hostedUrl: "https://pay.example/request-a",
    });
  });

  test("allows an agent owned by the caller's organization", async () => {
    const response = await app.fetch(createRequest("agent-a"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true });
    expect(getAgentForWrite).toHaveBeenCalledWith("agent-a", "org-a");
    expect(createPaymentRequest).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-a", agentId: "agent-a" }),
    );
  });

  test.each(["foreign-agent", "missing-agent"])(
    "rejects a %s before creating a payment request",
    async (agentId) => {
      getAgentForWrite.mockResolvedValueOnce(undefined);

      const response = await app.fetch(createRequest(agentId));

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        error: "Agent not found",
        code: "resource_not_found",
      });
      expect(getAgentForWrite).toHaveBeenCalledWith(agentId, "org-a");
      expect(createPaymentRequest).not.toHaveBeenCalled();
    },
  );
});
