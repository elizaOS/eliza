/**
 * Authenticated Headscale health checks use deterministic HTTP responses while
 * preserving the production request shape and alert/throw boundary.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  assertHeadscaleApiKeyHealthy,
  checkHeadscaleApiKeyHealth,
  HeadscaleApiKeyHealthError,
} from "./headscale-api-key-health";

const ENV = {
  HEADSCALE_API_URL: "http://127.0.0.1:8081/",
  HEADSCALE_API_KEY: "live-key",
} as NodeJS.ProcessEnv;

describe("checkHeadscaleApiKeyHealth", () => {
  test("proves the configured bearer key against the read-only users endpoint", async () => {
    const fetchImpl = mock(async () => new Response('{"users":[]}', { status: 200 }));

    const result = await checkHeadscaleApiKeyHealth({ env: ENV, fetchImpl });

    expect(result).toEqual({
      healthy: true,
      endpoint: "http://127.0.0.1:8081/api/v1/user",
      status: 200,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8081/api/v1/user");
    expect(init?.method).toBe("GET");
    expect(init?.headers).toEqual({ Authorization: "Bearer live-key" });
  });

  test("fails explicitly without sending a request when the key is missing", async () => {
    const fetchImpl = mock(async () => new Response(null, { status: 200 }));

    const result = await checkHeadscaleApiKeyHealth({
      env: { HEADSCALE_API_URL: "http://headscale.internal" } as NodeJS.ProcessEnv,
      fetchImpl,
    });

    expect(result.healthy).toBe(false);
    if (result.healthy) throw new Error("expected unhealthy result");
    expect(result.code).toBe("HEADSCALE_API_KEY_MISSING");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([401, 403])("classifies HTTP %i as a rejected key", async (status) => {
    const result = await checkHeadscaleApiKeyHealth({
      env: ENV,
      fetchImpl: async () => new Response(null, { status }),
    });

    expect(result.healthy).toBe(false);
    if (result.healthy) throw new Error("expected unhealthy result");
    expect(result.code).toBe("HEADSCALE_API_KEY_REJECTED");
    expect(result.status).toBe(status);
  });

  test("classifies non-auth HTTP failures without reading or logging a response body", async () => {
    const result = await checkHeadscaleApiKeyHealth({
      env: ENV,
      fetchImpl: async () => new Response("secret diagnostic", { status: 503 }),
    });

    expect(result.healthy).toBe(false);
    if (result.healthy) throw new Error("expected unhealthy result");
    expect(result.code).toBe("HEADSCALE_API_UNHEALTHY");
    expect(result.message).not.toContain("secret diagnostic");
  });

  test("classifies transport failures as unhealthy", async () => {
    const result = await checkHeadscaleApiKeyHealth({
      env: ENV,
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });

    expect(result.healthy).toBe(false);
    if (result.healthy) throw new Error("expected unhealthy result");
    expect(result.code).toBe("HEADSCALE_API_UNHEALTHY");
    expect(result.message).toContain("connection refused");
  });
});

describe("assertHeadscaleApiKeyHealthy", () => {
  test("is silent when the authenticated probe succeeds", async () => {
    const alert = mock(async () => {});
    const health = {
      healthy: true as const,
      endpoint: "http://headscale/api/v1/user",
      status: 200,
    };

    await expect(
      assertHeadscaleApiKeyHealthy({ check: async () => health, alert }),
    ).resolves.toEqual(health);
    expect(alert).not.toHaveBeenCalled();
  });

  test("pages with a stable dedup key and throws a typed failure", async () => {
    const alert = mock(async () => {});
    const health = {
      healthy: false as const,
      endpoint: "http://headscale/api/v1/user",
      status: 401,
      code: "HEADSCALE_API_KEY_REJECTED" as const,
      message: "Headscale rejected the key",
    };

    const promise = assertHeadscaleApiKeyHealthy({
      check: async () => health,
      alert,
    });

    await expect(promise).rejects.toBeInstanceOf(HeadscaleApiKeyHealthError);
    await expect(promise).rejects.toMatchObject({
      code: "HEADSCALE_API_KEY_REJECTED",
      severity: "fatal",
      context: {
        endpoint: "http://headscale/api/v1/user",
        status: 401,
      },
    });
    expect(alert).toHaveBeenCalledWith({
      title: "Headscale API key is unhealthy",
      message: "Headscale rejected the key",
      dedupKey: "headscale-api-key-unhealthy",
      details: {
        code: "HEADSCALE_API_KEY_REJECTED",
        endpoint: "http://headscale/api/v1/user",
        status: 401,
      },
    });
  });
});
