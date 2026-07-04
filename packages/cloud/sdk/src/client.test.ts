/** Unit tests for `ElizaCloudClient` against a recording mock fetch: auth-header injection, request shaping, and `CloudApiError` on non-2xx. */

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
  it("normalizes origin-only apiBaseUrl inputs to the Cloud API v1 base", async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl = (async (input, init = {}) => {
      requests.push({
        url: String(input),
        method: init.method ?? "GET",
        headers: Object.fromEntries(new Headers(init.headers).entries()),
      });
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const client = new ElizaCloudClient({
      apiBaseUrl: "https://api-staging.elizacloud.ai",
      fetchImpl,
    });

    expect(client.apiBaseUrl).toBe("https://api-staging.elizacloud.ai/api/v1");
    await client.listModels();
    expect(requests[0]?.url).toBe(
      "https://api-staging.elizacloud.ai/api/v1/models",
    );
  });

  it("rejects apiBaseUrl values that already include a resource path or URL components", () => {
    expect(
      () =>
        new ElizaCloudClient({
          apiBaseUrl: "https://api-staging.elizacloud.ai/api/v1/models",
        }),
    ).toThrow("/api/v1");
    expect(
      () =>
        new ElizaCloudClient({
          apiBaseUrl: "https://api-staging.elizacloud.ai/api/v1?debug=1",
        }),
    ).toThrow("query or hash");
  });

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

describe("ElizaCloudClient.createContainer wire contract", () => {
  it("serializes a camelCase body so projectName and environmentVars.ELIZA_APP_ID survive (per-app monetization)", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      data: { id: "c_1" },
    });

    // Typed against CreateContainerRequest: this object only compiles if the
    // SDK type is camelCase. A revert to snake_case fails the build here.
    await client.createContainer({
      name: "My App",
      image: "ghcr.io/elizaos/my-app:latest",
      projectName: "my-app",
      port: 3000,
      cpu: 1792,
      memoryMb: 1792,
      environmentVars: { ELIZA_APP_ID: "app_abc123", FOO: "bar" },
      healthCheckPath: "/health",
    });

    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/containers",
      method: "POST",
    });

    const body = requests[0]?.body as Record<string, unknown>;
    // The exact keys the server's CreateContainerSchema accepts — all camelCase.
    expect(body).toMatchObject({
      name: "My App",
      image: "ghcr.io/elizaos/my-app:latest",
      projectName: "my-app",
      port: 3000,
      cpu: 1792,
      memoryMb: 1792,
      healthCheckPath: "/health",
    });
    // ELIZA_APP_ID rides through environmentVars — the field the casing bug dropped.
    expect((body.environmentVars as Record<string, string>).ELIZA_APP_ID).toBe(
      "app_abc123",
    );

    // Regression guard: none of the legacy snake_case keys may reach the wire.
    // Those are exactly what the server zod silently stripped, taking
    // ELIZA_APP_ID and the sticky projectName with them.
    for (const dropped of [
      "project_name",
      "environment_vars",
      "health_check_path",
      "memory",
      "desired_count",
    ]) {
      expect(body).not.toHaveProperty(dropped);
    }
  });

  it("sends the action-discriminated PATCH body verbatim for updateContainer", async () => {
    const { client, requests } = createClientRecorder({ success: true });

    await client.updateContainer("c_1", { action: "scale", desiredCount: 1 });

    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/containers/c_1",
      method: "PATCH",
      body: { action: "scale", desiredCount: 1 },
    });
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
      "https://elizacloud.ai/auth/cli-login?session=cli-test-session",
    );
  });
});

describe("ElizaCloudClient web sign-in + app-credits affordances", () => {
  it("sends X-App-Id when an appId is passed to createChatCompletion", async () => {
    const { client, requests } = createClientRecorder({
      choices: [{ message: { role: "assistant", content: "hi" } }],
    });

    await client.createChatCompletion(
      {
        model: "anthropic/claude-sonnet-4.5",
        messages: [{ role: "user", content: "hi" }],
      },
      { appId: "app-123" },
    );

    expect(requests[0].url).toContain("/api/v1/chat/completions");
    expect(requests[0].headers["x-app-id"]).toBe("app-123");
  });

  it("omits X-App-Id when no appId is given", async () => {
    const { client, requests } = createClientRecorder({ choices: [] });
    await client.createChatCompletion({
      model: "anthropic/claude-sonnet-4.5",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(requests[0].headers["x-app-id"]).toBeUndefined();
  });

  it("sends X-Affiliate-Code (with X-App-Id) for affiliate revenue share", async () => {
    const { client, requests } = createClientRecorder({
      choices: [{ message: { role: "assistant", content: "hi" } }],
    });

    await client.createChatCompletion(
      {
        model: "anthropic/claude-sonnet-4.5",
        messages: [{ role: "user", content: "hi" }],
      },
      { appId: "app-123", affiliateCode: "aff-xyz" },
    );

    expect(requests[0].headers["x-app-id"]).toBe("app-123");
    expect(requests[0].headers["x-affiliate-code"]).toBe("aff-xyz");
  });

  it("sends X-Affiliate-Code without an appId", async () => {
    const { client, requests } = createClientRecorder({ choices: [] });
    await client.createChatCompletion(
      {
        model: "anthropic/claude-sonnet-4.5",
        messages: [{ role: "user", content: "hi" }],
      },
      { affiliateCode: "aff-xyz" },
    );
    expect(requests[0].headers["x-app-id"]).toBeUndefined();
    expect(requests[0].headers["x-affiliate-code"]).toBe("aff-xyz");
  });

  it("omits X-Affiliate-Code when no affiliateCode is given", async () => {
    const { client, requests } = createClientRecorder({ choices: [] });
    await client.createChatCompletion(
      {
        model: "anthropic/claude-sonnet-4.5",
        messages: [{ role: "user", content: "hi" }],
      },
      { appId: "app-123" },
    );
    expect(requests[0].headers["x-affiliate-code"]).toBeUndefined();
  });

  it("waitForCliLogin polls until authenticated and returns the key", async () => {
    const statuses = ["pending", "pending", "authenticated"];
    let call = 0;
    const fetchImpl = (async (_input, _init = {}) => {
      const status = statuses[Math.min(call++, statuses.length - 1)];
      const body =
        status === "authenticated"
          ? { status, apiKey: "eliza_new_key", userId: "user-9" }
          : { status };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const client = new ElizaCloudClient({
      baseUrl: "https://cloud.test",
      fetchImpl,
    });
    const result = await client.waitForCliLogin("sess-1", {
      intervalMs: 1,
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("authenticated");
    expect(result.apiKey).toBe("eliza_new_key");
    expect(result.userId).toBe("user-9");
    expect(call).toBeGreaterThanOrEqual(3);
  });

  it("waitForCliLogin throws on an expired session", async () => {
    const fetchImpl = (async (_input, _init = {}) =>
      new Response(
        JSON.stringify({ status: "expired", error: "session expired" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      )) as typeof fetch;
    const client = new ElizaCloudClient({
      baseUrl: "https://cloud.test",
      fetchImpl,
    });
    await expect(
      client.waitForCliLogin("sess-2", { intervalMs: 1 }),
    ).rejects.toThrow(/expired/i);
  });
});

describe("ElizaCloudClient.transcribeAudio", () => {
  it("POSTs multipart audio to /api/v1/voice/stt with X-App-Id", async () => {
    let captured:
      | { url: string; method?: string; headers: Headers; body: unknown }
      | undefined;
    const fetchImpl = (async (input, init = {}) => {
      captured = {
        url: String(input),
        method: init.method,
        headers: new Headers(init.headers),
        body: init.body,
      };
      return new Response(
        JSON.stringify({ transcript: "hello world", duration_ms: 1234 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const client = new ElizaCloudClient({
      baseUrl: "https://cloud.test",
      apiKey: "eliza_test_key",
      fetchImpl,
    });
    const res = await client.transcribeAudio(
      {
        audio: new Blob(["fake-audio"], { type: "audio/webm" }),
        filename: "speech.webm",
        languageCode: "en",
      },
      { appId: "app-123" },
    );

    expect(res).toEqual({ transcript: "hello world", duration_ms: 1234 });
    expect(captured?.url).toContain("/api/v1/voice/stt");
    expect(captured?.method).toBe("POST");
    expect(captured?.headers.get("x-app-id")).toBe("app-123");
    expect(captured?.headers.get("authorization")).toBe(
      "Bearer eliza_test_key",
    );
    // A FormData body (not a JSON string) confirms multipart — the runtime sets
    // the multipart boundary, so the SDK never forces application/json here.
    expect(captured?.body).toBeInstanceOf(FormData);
    const form = captured?.body as FormData;
    expect(form.get("languageCode")).toBe("en");
    expect(form.get("audio")).toBeInstanceOf(Blob);
  });
});
