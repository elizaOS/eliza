import { ElizaClient } from "@elizaos/app-core/api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("ElizaClient sandbox monitor endpoints", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(
      async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("calls browser, windows, and screenshot sandbox APIs", async () => {
    const api = new ElizaClient("http://localhost:2138", "token");

    await api.getSandboxBrowser();
    await api.getSandboxWindows();
    await api.getSandboxScreenshot();
    await api.getSandboxScreenshot({
      x: 12,
      y: 34,
      width: 640,
      height: 360,
    });

    const calls = fetchMock.mock.calls.map((call) => ({
      url: String(call[0]),
      method: (call[1]?.method as string | undefined) ?? "GET",
      body: call[1]?.body as string | undefined,
      headers: call[1]?.headers as Record<string, string> | undefined,
    }));

    expect(calls).toContainEqual({
      url: "http://localhost:2138/api/sandbox/browser",
      method: "GET",
      body: undefined,
      headers: expect.objectContaining({
        "Content-Type": "application/json",
      }),
    });

    expect(calls).toContainEqual({
      url: "http://localhost:2138/api/sandbox/screen/windows",
      method: "GET",
      body: undefined,
      headers: expect.objectContaining({
        "Content-Type": "application/json",
      }),
    });

    expect(calls).toContainEqual({
      url: "http://localhost:2138/api/sandbox/screen/screenshot",
      method: "POST",
      body: undefined,
      headers: expect.objectContaining({
        "Content-Type": "application/json",
      }),
    });

    expect(calls).toContainEqual({
      url: "http://localhost:2138/api/sandbox/screen/screenshot",
      method: "POST",
      body: JSON.stringify({
        x: 12,
        y: 34,
        width: 640,
        height: 360,
      }),
      headers: expect.objectContaining({
        "Content-Type": "application/json",
      }),
    });
  });

  test("parses noVNC endpoint from browser metadata", async () => {
    fetchMock.mockImplementationOnce(
      async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            cdpEndpoint: "http://localhost:9222",
            wsEndpoint: "ws://localhost:9222",
            noVncEndpoint: "http://localhost:6080/vnc.html",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );

    const api = new ElizaClient("http://localhost:2138", "token");
    const browser = await api.getSandboxBrowser();
    expect(browser.noVncEndpoint).toBe("http://localhost:6080/vnc.html");
  });
});
