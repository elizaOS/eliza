import { describe, expect, it } from "vitest";
import { ElizaCloudClient } from "./client.js";
import { CloudApiError } from "./http.js";

type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

function createClientRecorder(
  responseBody: Record<string, unknown> = { success: true },
) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input, init = {}) => {
    const headers = new Headers(init.headers);
    requests.push({
      url: String(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      body:
        typeof init.body === "string" && init.body.length > 0
          ? JSON.parse(init.body)
          : undefined,
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
    const { client, requests } = createClientRecorder({
      success: true,
      charge: { id: "chg_1" },
    });

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

    expect(
      requests.map(
        (request) => `${request.method} ${new URL(request.url).pathname}`,
      ),
    ).toEqual([
      "POST /api/v1/apps/app_1/charges",
      "POST /api/v1/apps/app_1/charges/chg_1/checkout",
    ]);
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

    expect(
      requests.map(
        (request) => `${request.method} ${new URL(request.url).pathname}`,
      ),
    ).toEqual([
      "POST /api/v1/affiliates",
      "POST /api/v1/apps/app_1/earnings/withdraw",
      "POST /api/v1/redemptions",
    ]);
  });
});

describe("ElizaCloudClient.getContainerLogs", () => {
  it("requests text logs with tail and returns the raw body on a 2xx response", async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl = (async (input, init = {}) => {
      const headers = new Headers(init.headers);
      requests.push({
        url: String(input),
        method: init.method ?? "GET",
        headers: Object.fromEntries(headers.entries()),
      });
      return new Response("line1\nline2\n", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }) as typeof fetch;

    const client = new ElizaCloudClient({
      baseUrl: "https://cloud.test",
      apiKey: "eliza_test_key",
      fetchImpl,
    });

    expect(await client.getContainerLogs("c_1", 50)).toBe("line1\nline2\n");
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/containers/c_1/logs?tail=50",
      method: "GET",
    });
    expect(requests[0]?.headers.accept).toBe("text/plain");
    expect(requests[0]?.headers.authorization).toBe("Bearer eliza_test_key");
  });

  it("throws CloudApiError carrying status and body on a non-ok response", async () => {
    const fetchImpl = (async (_input) =>
      new Response("container not found", {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "text/plain" },
      })) as typeof fetch;

    const client = new ElizaCloudClient({
      baseUrl: "https://cloud.test",
      apiKey: "eliza_test_key",
      fetchImpl,
    });

    let thrown: unknown;
    try {
      await client.getContainerLogs("c_missing");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CloudApiError);
    expect(thrown).toMatchObject({
      name: "CloudApiError",
      statusCode: 404,
    });
    expect(String((thrown as Error).message)).toMatch(/container not found/);
  });
});

describe("ElizaCloudClient path parameter encoding", () => {
  it("percent-encodes path parameters that contain slashes, query markers, and fragments", async () => {
    const { client, requests } = createClientRecorder();

    await client.getX402PaymentRequest("pay/../evil?x=1#frag");
    await client.getAppCharge("app/id?admin=true", "charge#frag/settle");

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/v1/x402/requests/pay%2F..%2Fevil%3Fx%3D1%23frag",
      "/api/v1/apps/app%2Fid%3Fadmin%3Dtrue/charges/charge%23frag%2Fsettle",
    ]);
  });

  it("fails fast when templated endpoint calls omit a required path parameter", async () => {
    const { client } = createClientRecorder();

    expect(() =>
      client.callEndpoint("GET", "/api/auth/cli-session/{sessionId}", {
        pathParams: {},
        skipAuth: true,
      }),
    ).toThrow("Missing path parameter: sessionId");
  });
});

describe("ElizaCloudClient CLI login", () => {
  it("uses the API host for session creation but the web host for browser auth", async () => {
    let requestedUrl: string | undefined;
    const fetchImpl = (async (input) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          status: "pending",
          expiresAt: "2026-05-14T08:00:00.000Z",
        }),
        {
          status: 201,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    const client = new ElizaCloudClient({
      baseUrl: "https://api.elizacloud.ai",
      fetchImpl,
    });

    const result = await client.startCliLogin({
      sessionId: "cli-test-session",
    });

    expect(requestedUrl).toBe("https://api.elizacloud.ai/api/auth/cli-session");
    expect(result.browserUrl).toBe(
      "https://www.elizacloud.ai/auth/cli-login?session=cli-test-session",
    );
  });
});
