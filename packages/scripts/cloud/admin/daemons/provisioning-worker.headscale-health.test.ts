/**
 * The provisioning daemon delegates authenticated Headscale health checks to
 * the shared alerting gate and propagates failures to its bounded phase.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  __setDepsForTests,
  processHeadscaleApiKeyHealthCycle,
} from "./provisioning-worker";

afterEach(() => {
  __setDepsForTests(null);
});

describe("processHeadscaleApiKeyHealthCycle", () => {
  test("returns the authenticated probe result unchanged", async () => {
    const health = {
      healthy: true as const,
      endpoint: "http://127.0.0.1:8081/api/v1/user",
      status: 200,
    };
    const assertHeadscaleApiKeyHealthy = mock(async () => health);
    __setDepsForTests({ assertHeadscaleApiKeyHealthy } as unknown as Parameters<
      typeof __setDepsForTests
    >[0]);

    await expect(processHeadscaleApiKeyHealthCycle()).resolves.toEqual(health);
    expect(assertHeadscaleApiKeyHealthy).toHaveBeenCalledTimes(1);
  });

  test("propagates a rejected key so startup fails and the bounded cycle fails closed", async () => {
    const assertHeadscaleApiKeyHealthy = mock(async () => {
      throw new Error("Headscale rejected HEADSCALE_API_KEY with HTTP 401");
    });
    __setDepsForTests({ assertHeadscaleApiKeyHealthy } as unknown as Parameters<
      typeof __setDepsForTests
    >[0]);

    await expect(processHeadscaleApiKeyHealthCycle()).rejects.toThrow(
      "HTTP 401",
    );
  });
});
