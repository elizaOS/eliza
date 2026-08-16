/** Verifies Discord gateway renewal returns to the bootstrap-secret exchange. */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { GatewayManager } from "../src/gateway-manager";

interface AuthHarness {
  refreshToken(): Promise<void>;
  scheduleTokenRefresh(expiresInSeconds: number): void;
  tokenRefreshTimeout: NodeJS.Timeout | null;
  accessToken: string | null;
  authStopped: boolean;
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
    harness.authStopped = false;
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

  test("paces retry after a malformed scheduled bootstrap response", async () => {
    let bootstraps = 0;
    globalThis.fetch = mock(async () => {
      bootstraps += 1;
      if (bootstraps === 1) {
        return new Response(
          JSON.stringify({
            access_token: "",
            token_type: "Bearer",
            expires_in: 60,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
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
    harness.authStopped = false;
    try {
      harness.scheduleTokenRefresh(0.01);
      await waitFor(() => bootstraps === 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(bootstraps).toBe(1);
      await waitFor(() => bootstraps === 2);
    } finally {
      if (harness.tokenRefreshTimeout)
        clearTimeout(harness.tokenRefreshTimeout);
    }

    expect(bootstraps).toBe(2);
  });

  test.each([
    { access_token: "", token_type: "Bearer", expires_in: 60 },
    { access_token: "token", token_type: "Bearer", expires_in: 61 },
    { access_token: "token", token_type: "bearer", expires_in: 60 },
  ])(
    "rejects malformed bootstrap responses without publishing state",
    async (body) => {
      globalThis.fetch = mock(
        async () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ) as typeof fetch;

      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "https://api.test",
        gatewayBootstrapSecret: "bootstrap-secret",
        project: "test",
      });
      const harness = manager as unknown as AuthHarness;
      harness.authStopped = false;

      await expect(harness.refreshToken()).rejects.toThrow(
        "Invalid token response",
      );
      expect(harness.accessToken).toBeNull();
      expect(harness.tokenRefreshTimeout).toBeNull();
    },
  );

  test("shutdown fences an in-flight bootstrap completion", async () => {
    const response = deferred<Response>();
    globalThis.fetch = mock(async () => response.promise) as typeof fetch;

    const manager = new GatewayManager({
      podName: "test-pod",
      elizaCloudUrl: "https://api.test",
      gatewayBootstrapSecret: "bootstrap-secret",
      project: "test",
    });
    const harness = manager as unknown as AuthHarness;
    harness.authStopped = false;
    const refresh = harness.refreshToken();

    await manager.shutdown();
    response.resolve(
      new Response(
        JSON.stringify({
          access_token: "late-token",
          token_type: "Bearer",
          expires_in: 60,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(refresh).rejects.toThrow(
      "Token acquisition completed after authentication stopped",
    );
    expect(harness.accessToken).toBeNull();
    expect(harness.tokenRefreshTimeout).toBeNull();
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for retry");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
