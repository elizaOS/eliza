/**
 * Action-surface tests for PROXY_STATUS: they drive the real
 * `proxyStatusAction.handler` against a stubbed AnthropicProxyService so the
 * status-formatting production logic (line assembly, optional fields, the
 * service-missing degrade) is exercised deterministically without a live proxy
 * or network. The service is a legitimate runtime boundary here — the handler's
 * own DTO shaping is the code under test.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { proxyStatusAction } from "../src/actions/proxy-status.action.js";
import { ANTHROPIC_PROXY_SERVICE_NAME } from "../src/services/proxy-service.js";

// PROXY_STATUS reads only `runtime`, but the Handler/Validator signatures still
// require a message; a placeholder satisfies the type without affecting output.
const message = {} as unknown as Memory;

async function runHandler(runtime: IAgentRuntime) {
  const result = await proxyStatusAction.handler(runtime, message);
  if (!result) {
    throw new Error("PROXY_STATUS handler returned no ActionResult");
  }
  return result;
}

type ProxyStatus = Awaited<
  ReturnType<import("../src/services/proxy-service.js").AnthropicProxyService["getStatus"]>
>;

function runtimeWithStatus(status: ProxyStatus | null): IAgentRuntime {
  return {
    getService(name: string) {
      if (name !== ANTHROPIC_PROXY_SERVICE_NAME || status === null) {
        return null;
      }
      return { getStatus: async () => status };
    },
  } as unknown as IAgentRuntime;
}

describe("PROXY_STATUS action", () => {
  it("validates unconditionally so operators can always query status", async () => {
    await expect(proxyStatusAction.validate(runtimeWithStatus(null), message)).resolves.toBe(true);
  });

  it("reports an explicit unavailable result when the service is not loaded", async () => {
    const result = await runHandler(runtimeWithStatus(null));
    expect(result.success).toBe(false);
    expect(result.text).toContain("not loaded");
    expect(result.values?.available).toBe(false);
  });

  it("formats a full shared-mode status, including upstream reachability", async () => {
    const status: ProxyStatus = {
      mode: "shared",
      url: "http://127.0.0.1:8787",
      listening: true,
      startError: null,
      stats: {
        requestsServed: 42,
        uptimeSec: 1234,
        tokenExpiresInHours: 5.25,
        subscriptionType: "max",
      } as ProxyStatus["stats"],
      upstream: { reachable: true, status: 200 },
    };
    const result = await runHandler(runtimeWithStatus(status));

    expect(result.success).toBe(true);
    expect(result.text).toContain("mode: shared");
    expect(result.text).toContain("url: http://127.0.0.1:8787");
    expect(result.text).toContain("listening: true");
    expect(result.text).toContain("requests: 42");
    expect(result.text).toContain("uptime: 1234s");
    // toFixed(1) rounding is the production contract for the expiry line.
    expect(result.text).toContain("tokenExpiresInHours: 5.3");
    expect(result.text).toContain("subscription: max");
    expect(result.text).toContain("upstream: reachable=true status=200");
    expect(result.values?.available).toBe(true);
    expect(result.values?.mode).toBe("shared");
  });

  it("degrades optional fields: null url, startError, null token expiry, unreachable upstream", async () => {
    const status: ProxyStatus = {
      mode: "off",
      url: null,
      listening: false,
      startError: "boom",
      stats: {
        requestsServed: 0,
        uptimeSec: 0,
        tokenExpiresInHours: null,
        subscriptionType: null,
      } as ProxyStatus["stats"],
      upstream: { reachable: false, error: "timeout" },
    };
    const result = await runHandler(runtimeWithStatus(status));

    expect(result.success).toBe(true);
    expect(result.text).toContain("url: (none)");
    expect(result.text).toContain("startError: boom");
    expect(result.text).not.toContain("tokenExpiresInHours:");
    expect(result.text).toContain("subscription: unknown");
    expect(result.text).toContain("upstream: reachable=false status=n/a error=timeout");
  });
});
