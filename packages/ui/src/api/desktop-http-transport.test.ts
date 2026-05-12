import { describe, expect, it, vi } from "vitest";

const runtimeMock = vi.hoisted(() => ({
  isElectrobunRuntime: vi.fn(),
}));

const bridgeMock = vi.hoisted(() => ({
  getElectrobunRendererRpc: vi.fn(),
}));

vi.mock("../bridge/electrobun-runtime", () => runtimeMock);
vi.mock("../bridge/electrobun-rpc", () => bridgeMock);

import { desktopHttpTransportForUrl } from "./desktop-http-transport";

describe("desktopHttpTransportForUrl", () => {
  it("uses the desktop RPC bridge for external plain HTTP URLs", async () => {
    runtimeMock.isElectrobunRuntime.mockReturnValue(true);
    const desktopHttpRequest = vi.fn().mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    });
    const request = { desktopHttpRequest };
    bridgeMock.getElectrobunRendererRpc.mockReturnValue({ request });

    const transport = desktopHttpTransportForUrl("http://147.93.44.246:2138");
    expect(transport).not.toBeNull();

    const response = await transport?.request(
      "http://147.93.44.246:2138/api/auth/status",
      { headers: { "Content-Type": "application/json" } },
      { timeoutMs: 1234 },
    );

    expect(desktopHttpRequest).toHaveBeenCalledWith({
      url: "http://147.93.44.246:2138/api/auth/status",
      method: "GET",
      headers: { "content-type": "application/json" },
      body: null,
      timeoutMs: 1234,
    });
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ ok: true });
  });

  it("leaves local HTTP and HTTPS URLs on the regular fetch path", () => {
    runtimeMock.isElectrobunRuntime.mockReturnValue(true);

    expect(desktopHttpTransportForUrl("http://127.0.0.1:2138")).toBeNull();
    expect(desktopHttpTransportForUrl("http://localhost:2138")).toBeNull();
    expect(desktopHttpTransportForUrl("https://agent.example.com")).toBeNull();
  });
});
