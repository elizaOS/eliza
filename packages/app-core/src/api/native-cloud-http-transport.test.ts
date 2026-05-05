import { beforeEach, describe, expect, it, vi } from "vitest";

const { capacitorHttpRequestMock, isNativePlatformMock } = vi.hoisted(() => ({
  capacitorHttpRequestMock: vi.fn(),
  isNativePlatformMock: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: isNativePlatformMock,
  },
  CapacitorHttp: {
    request: capacitorHttpRequestMock,
  },
}));

import { nativeCloudHttpTransportForUrl } from "./native-cloud-http-transport";

describe("nativeCloudHttpTransportForUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isNativePlatformMock.mockReturnValue(false);
    capacitorHttpRequestMock.mockResolvedValue({
      data: { success: true },
      headers: { "content-type": "application/json" },
      status: 200,
      url: "https://api.elizacloud.ai/api/v1/eliza/agents",
    });
  });

  it("does not intercept non-native cloud requests", () => {
    expect(
      nativeCloudHttpTransportForUrl(
        "https://api.elizacloud.ai/api/v1/eliza/agents",
      ),
    ).toBeNull();
  });

  it("does not intercept native requests to non-cloud hosts", () => {
    isNativePlatformMock.mockReturnValue(true);

    expect(
      nativeCloudHttpTransportForUrl(
        "https://example.test/api/v1/eliza/agents",
      ),
    ).toBeNull();
  });

  it("uses Capacitor native HTTP for direct Eliza Cloud API requests", async () => {
    isNativePlatformMock.mockReturnValue(true);
    const transport = nativeCloudHttpTransportForUrl(
      "https://api.elizacloud.ai/api/v1/eliza/agents",
    );

    expect(transport).not.toBeNull();
    if (!transport) {
      throw new Error("expected native cloud HTTP transport");
    }
    const response = await transport.request(
      "https://api.elizacloud.ai/api/v1/eliza/agents",
      {
        headers: {
          Authorization: "Bearer cloud-token",
          "Content-Type": "application/json",
        },
        method: "POST",
        body: JSON.stringify({ agentName: "My Agent" }),
      },
      { timeoutMs: 10_000 },
    );

    expect(capacitorHttpRequestMock).toHaveBeenCalledWith({
      url: "https://api.elizacloud.ai/api/v1/eliza/agents",
      method: "POST",
      headers: {
        authorization: "Bearer cloud-token",
        "content-type": "application/json",
      },
      data: JSON.stringify({ agentName: "My Agent" }),
      responseType: "text",
      connectTimeout: 10_000,
      readTimeout: 10_000,
    });
    await expect(response.json()).resolves.toEqual({ success: true });
  });
});
