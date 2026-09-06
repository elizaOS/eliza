/**
 * Unit coverage for the desktop HTTP transport: Electrobun-RPC vs fetch routing.
 * Runtime detection mocked, no real shell.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("uses the desktop RPC bridge for the configured external desktop API base even when it is loopback", async () => {
    runtimeMock.isElectrobunRuntime.mockReturnValue(true);
    vi.stubGlobal("window", {
      __ELIZA_DESKTOP_EXTERNAL_API_BASE__: "http://127.0.0.1:2138",
    });
    const desktopHttpRequest = vi.fn().mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    });
    const request = { desktopHttpRequest };
    bridgeMock.getElectrobunRendererRpc.mockReturnValue({ request });

    const transport = desktopHttpTransportForUrl("http://127.0.0.1:2138");
    expect(transport).not.toBeNull();

    const response = await transport?.request(
      "http://127.0.0.1:2138/api/config",
      {},
      { timeoutMs: 1234 },
    );

    expect(desktopHttpRequest).toHaveBeenCalledWith({
      url: "http://127.0.0.1:2138/api/config",
      method: "GET",
      headers: {},
      body: null,
      timeoutMs: 1234,
    });
    expect(response?.status).toBe(200);
  });

  it("settles a canceled bridge request and permits a fresh retry", async () => {
    runtimeMock.isElectrobunRuntime.mockReturnValue(true);
    const desktopHttpRequest = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce({ status: 200, body: '{"ready":true}' });
    bridgeMock.getElectrobunRendererRpc.mockReturnValue({
      request: { desktopHttpRequest },
    });
    const transport = desktopHttpTransportForUrl("https://api.eliza.app");
    if (!transport) throw new Error("Missing desktop transport");
    const controller = new AbortController();
    const result = transport.request(
      "https://api.eliza.app/api/auth/cli-session",
      { signal: controller.signal },
    );
    const rejection = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejection;
    const response = await transport.request(
      "https://api.eliza.app/api/auth/cli-session",
      {},
    );
    await expect(response.json()).resolves.toEqual({ ready: true });
  });

  it("enforces the caller deadline when the native bridge never settles", async () => {
    vi.useFakeTimers();
    try {
      runtimeMock.isElectrobunRuntime.mockReturnValue(true);
      const desktopHttpRequest = vi.fn(() => new Promise(() => undefined));
      bridgeMock.getElectrobunRendererRpc.mockReturnValue({
        request: { desktopHttpRequest },
      });
      const transport = desktopHttpTransportForUrl("https://api.eliza.app");
      if (!transport) throw new Error("Missing desktop transport");
      const result = transport.request(
        "https://api.eliza.app/api/auth/cli-session",
        {},
        { timeoutMs: 1000 },
      );
      const rejection = expect(result).rejects.toMatchObject({
        name: "TimeoutError",
      });
      await vi.advanceTimersByTimeAsync(1000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves unconfigured local HTTP and HTTPS URLs on the regular fetch path", () => {
    runtimeMock.isElectrobunRuntime.mockReturnValue(true);

    expect(desktopHttpTransportForUrl("http://127.0.0.1:2138")).toBeNull();
    expect(desktopHttpTransportForUrl("http://localhost:2138")).toBeNull();
    expect(desktopHttpTransportForUrl("https://agent.example.com")).toBeNull();
  });
});
