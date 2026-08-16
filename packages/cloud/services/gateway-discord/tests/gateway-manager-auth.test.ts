/** Verifies Discord gateway renewal returns to the bootstrap-secret exchange. */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { GatewayManager } from "../src/gateway-manager";

interface AuthHarness {
  refreshToken(): Promise<void>;
  tokenRefreshTimeout: NodeJS.Timeout | null;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("GatewayManager token renewal", () => {
  test("re-bootstraps with the gateway secret instead of bearer self-refresh", async () => {
    const requests: Array<{
      path: string;
      authorization: string | null;
      secret: string | null;
    }> = [];
    globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        path: new URL(String(input)).pathname,
        authorization: headers.get("authorization"),
        secret: headers.get("x-gateway-secret"),
      });
      return new Response(
        JSON.stringify({
          access_token: "replacement-token",
          token_type: "Bearer",
          expires_in: 60,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const manager = new GatewayManager({
      podName: "test-pod",
      elizaCloudUrl: "https://api.test",
      gatewayBootstrapSecret: "bootstrap-secret",
      project: "test",
    });
    const harness = manager as unknown as AuthHarness;
    try {
      await harness.refreshToken();
    } finally {
      if (harness.tokenRefreshTimeout)
        clearTimeout(harness.tokenRefreshTimeout);
    }

    expect(requests).toEqual([
      {
        path: "/api/internal/auth/token",
        authorization: null,
        secret: "bootstrap-secret",
      },
    ]);
  });
});
