import * as http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { handleCloudBillingRoute } from "../src/routes/cloud-billing-routes";

const originalNodeEnv = process.env.NODE_ENV;
const originalCloudBaseUrl = process.env.ELIZAOS_CLOUD_BASE_URL;
const originalFetch = globalThis.fetch;

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected TCP server address");
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  globalThis.fetch = originalFetch;
  if (originalCloudBaseUrl === undefined) {
    delete process.env.ELIZAOS_CLOUD_BASE_URL;
  } else {
    process.env.ELIZAOS_CLOUD_BASE_URL = originalCloudBaseUrl;
  }
});

describe("handleCloudBillingRoute money proxies", () => {
  it("forwards x402 payment requests and preserves payment headers", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.ELIZAOS_CLOUD_BASE_URL;

    let upstreamRequest:
      | {
          method: string;
          url: string;
          authorization: string | undefined;
          body: Record<string, unknown>;
        }
      | undefined;

    globalThis.fetch = (async (input, init = {}) => {
      const headers = new Headers(init.headers);
      upstreamRequest = {
        method: init.method ?? "GET",
        url: String(input),
        authorization: headers.get("Authorization") ?? undefined,
        body: typeof init.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : {},
      };
      return new Response(
        JSON.stringify({
          success: true,
          paymentRequest: { id: "pay_1", paid: false },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "PAYMENT-REQUIRED": "encoded-payment-required",
          },
        }
      );
    }) as typeof fetch;

    const proxy = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void handleCloudBillingRoute(req, res, url.pathname, (req.method ?? "GET").toUpperCase(), {
        config: {
          cloud: {
            apiKey: "eliza_test_key",
            baseUrl: "https://www.elizacloud.ai",
          },
        },
        runtime: null,
      });
    });
    const proxyBaseUrl = await listen(proxy);

    try {
      const response = await originalFetch(`${proxyBaseUrl}/api/cloud/billing/x402/requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountUsd: 5,
          network: "base",
          callback_channel: { roomId: "room-1", agentId: "agent-1" },
        }),
      });

      await expect(response.json()).resolves.toMatchObject({
        success: true,
        paymentRequest: { id: "pay_1" },
      });
      expect(response.headers.get("PAYMENT-REQUIRED")).toBe("encoded-payment-required");
      expect(upstreamRequest).toEqual({
        method: "POST",
        url: "https://www.elizacloud.ai/api/v1/x402/requests",
        authorization: "Bearer eliza_test_key",
        body: {
          amountUsd: 5,
          network: "base",
          callback_channel: { roomId: "room-1", agentId: "agent-1" },
        },
      });
    } finally {
      await close(proxy);
    }
  });
});
