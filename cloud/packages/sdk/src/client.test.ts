import { describe, expect, it } from "vitest";
import { ElizaCloudClient } from "./client.js";

type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

function createClientRecorder(responseBody: Record<string, unknown> = { success: true }) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input, init = {}) => {
    const headers = new Headers(init.headers);
    requests.push({
      url: String(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      body:
        typeof init.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined,
    });

    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return {
    requests,
    client: new ElizaCloudClient({
      baseUrl: "https://cloud.test",
      apiKey: "eliza_test_key",
      fetchImpl,
    }),
  };
}

describe("ElizaCloudClient payment and monetization helpers", () => {
  it("creates durable x402 payment requests with callback channel metadata", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      paymentRequest: { id: "pay_1", paid: false },
      paymentRequired: { accepts: [] },
      paymentRequiredHeader: "encoded",
    });

    await client.createX402PaymentRequest({
      amountUsd: 5,
      network: "base",
      description: "support the agent",
      callback_channel: { roomId: "room-1", agentId: "agent-1" },
    });

    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/x402/requests",
      method: "POST",
      body: {
        amountUsd: 5,
        network: "base",
        description: "support the agent",
        callback_channel: { roomId: "room-1", agentId: "agent-1" },
      },
    });
    expect(requests[0]?.headers.authorization).toBe("Bearer eliza_test_key");
  });

  it("uses public x402 settlement routes without sending stored credentials", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      paymentRequest: { id: "pay_1", paid: true },
    });

    await client.settleX402PaymentRequest("pay_1", { x402Version: 2 });

    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/x402/requests/pay_1/settle",
      method: "POST",
      body: { paymentPayload: { x402Version: 2 } },
    });
    expect(requests[0]?.headers.authorization).toBeUndefined();
  });

  it("creates app charges and payer checkouts on the app money routes", async () => {
    const { client, requests } = createClientRecorder({ success: true, charge: { id: "chg_1" } });

    await client.createAppCharge("app_1", {
      amount: 7,
      providers: ["stripe", "oxapay"],
      callback_channel: { roomId: "room-1", agentId: "agent-1" },
    });
    await client.createAppChargeCheckout("app_1", "chg_1", {
      provider: "oxapay",
      payCurrency: "USDC",
      network: "BASE",
    });

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      ["POST /api/v1/apps/app_1/charges", "POST /api/v1/apps/app_1/charges/chg_1/checkout"],
    );
    expect(requests[1]?.body).toEqual({
      provider: "oxapay",
      payCurrency: "USDC",
      network: "BASE",
    });
  });

  it("routes affiliates, earnings, and token redemptions through typed helpers", async () => {
    const { client, requests } = createClientRecorder();

    await client.createAffiliateCode({ markupPercent: 10 });
    await client.withdrawAppEarnings("app_1", {
      amount: 25,
      idempotency_key: "idempotency-key-0001",
    });
    await client.createRedemption({
      pointsAmount: 500,
      network: "base",
      payoutAddress: "0x0000000000000000000000000000000000000001",
    });

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        "POST /api/v1/affiliates",
        "POST /api/v1/apps/app_1/earnings/withdraw",
        "POST /api/v1/redemptions",
      ],
    );
  });
});
