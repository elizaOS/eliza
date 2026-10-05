// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    isPluginAvailable: () => true,
  },
  registerPlugin: vi.fn(),
}));

import {
  handleIosLocalAgentNativeRequest,
  primeIosFullBunRuntime,
} from "./ios-local-agent-transport";

describe("native-only iOS agent transport", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubEnv("VITE_ELIZA_IOS_RUNTIME_MODE", "local");
    vi.stubEnv("VITE_ELIZA_IOS_FULL_BUN_AVAILABLE", "1");
  });
  afterEach(() => {
    primeIosFullBunRuntime(null);
    vi.unstubAllEnvs();
  });
  it("reports native agent unavailability instead of executing a renderer agent", async () => {
    primeIosFullBunRuntime(null);
    await expect(
      handleIosLocalAgentNativeRequest({
        path: "/api/conversations",
        method: "POST",
        body: "{}",
      }),
    ).rejects.toThrow("the native agent is unavailable");
    expect(
      localStorage.getItem("eliza:ios-local-agent:conversations:v1"),
    ).toBeNull();
  });
  it("preserves native error responses without a fallback or replay", async () => {
    const result = {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "content-type": "application/json" },
      body: '{"error":"starting"}',
    };
    const call = vi.fn().mockResolvedValue({ result });
    primeIosFullBunRuntime({ start: vi.fn(), getStatus: vi.fn(), call });
    await expect(
      handleIosLocalAgentNativeRequest({ path: "/api/status" }),
    ).resolves.toEqual(result);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("propagates cancellation before native dispatch", async () => {
    const call = vi.fn();
    primeIosFullBunRuntime({ start: vi.fn(), getStatus: vi.fn(), call });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      handleIosLocalAgentNativeRequest(
        { path: "/api/status" },
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
    expect(call).not.toHaveBeenCalled();
  });
});
