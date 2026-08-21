/**
 * Contract tests for the `AgentWeb` HTTP fallback, including a real loopback
 * response whose body stalls until the request deadline aborts it.
 */
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentWeb } from "./web";

function setWindow(overrides: Partial<Window> = {}): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { protocol: "https:", origin: "https://app.example" },
      sessionStorage: {
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
      ...overrides,
    },
  });
}

describe("AgentWeb fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns unavailable status without fetching when no HTTP API can be reached", async () => {
    setWindow({
      location: { protocol: "file:", origin: "file://" } as Location,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new AgentWeb().getStatus()).resolves.toEqual({
      state: "not_started",
      agentName: null,
      port: null,
      startedAt: null,
      error: "No API endpoint",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["", "   "])(
    "rejects blank chat text %s before fetch",
    async (text) => {
      setWindow();
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(new AgentWeb().chat({ text })).rejects.toThrow(
        "Agent.chat requires non-empty text",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    "",
    "api/status",
    "//evil.example/api/status",
    "/api\\status",
    "https://evil.example/api/status",
  ])("rejects unsafe request path %s before fetch", async (path) => {
    setWindow({
      __ELIZAOS_APP_BOOT_CONFIG__: { apiBase: "https://agent.example" },
    } as Partial<Window>);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new AgentWeb().request({ path })).rejects.toThrow(
      /Agent\.request/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["POST /evil", "TRACE\nX", "", "x".repeat(17)])(
    "rejects unsafe request method %s before fetch",
    async (method) => {
      setWindow({
        __ELIZAOS_APP_BOOT_CONFIG__: { apiBase: "https://agent.example" },
      } as Partial<Window>);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        new AgentWeb().request({ path: "/api/status", method }),
      ).rejects.toThrow("Unsupported HTTP method");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("sends normalized path-only requests with bearer auth", async () => {
    setWindow({
      __ELIZAOS_APP_BOOT_CONFIG__: { apiBase: "https://agent.example" },
      __ELIZA_API_TOKEN__: " token-123 ",
    } as Partial<Window>);
    const headers = new Headers({ "content-type": "application/json" });
    const fetchMock = vi.fn(async () => ({
      status: 202,
      statusText: "Accepted",
      headers,
      text: async () => '{"ok":true}',
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new AgentWeb().request({
        path: " /api/status ",
        method: "post",
        headers: { "x-test": "1" },
        body: "{}",
      }),
    ).resolves.toEqual({
      status: 202,
      statusText: "Accepted",
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://agent.example/api/status",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer token-123",
          "x-test": "1",
        },
        body: "{}",
      }),
    );
  });

  it("applies the owning deadline to every web fallback HTTP hop", async () => {
    setWindow({
      __ELIZAOS_APP_BOOT_CONFIG__: { apiBase: "https://agent.example" },
    } as Partial<Window>);
    const timeoutCalls: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      timeoutCalls.push(milliseconds);
      return new AbortController().signal;
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/conversations")) {
        return {
          ok: true,
          json: async () => ({ conversation: { id: "conversation-1" } }),
        };
      }
      if (url.endsWith("/messages")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ text: "reply", agentName: "Eliza" }),
        };
      }
      if (url.endsWith("/api/agent/start")) {
        return { json: async () => ({ status: { state: "running" } }) };
      }
      if (url.endsWith("/api/agent/stop")) {
        return { json: async () => ({ ok: true }) };
      }
      if (url.endsWith("/api/status")) {
        return {
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          json: async () => ({ state: "running" }),
          text: async () => "status",
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const agent = new AgentWeb();
    await agent.chat({ text: "hello" });
    await agent.start();
    await agent.stop();
    await agent.getStatus();
    await agent.request({ path: "/api/status" });
    await agent.request({ path: "/api/status", timeoutMs: 1_234.2 });
    await agent.request({ path: "/api/status", timeoutMs: 0.01 });
    await agent.request({ path: "/api/status", timeoutMs: Number.MAX_VALUE });

    expect(timeoutCalls).toEqual([
      30_000, 120_000, 30_000, 30_000, 30_000, 30_000, 1_235, 1, 2_147_483_647,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(9);
  });

  it("retries a missing chat conversation only once with fresh deadlines", async () => {
    let storedConversationId: string | null = "stale-conversation";
    setWindow({
      __ELIZAOS_APP_BOOT_CONFIG__: { apiBase: "https://agent.example" },
      sessionStorage: {
        getItem: vi.fn(() => storedConversationId),
        setItem: vi.fn((_key: string, value: string) => {
          storedConversationId = value;
        }),
        removeItem: vi.fn(() => {
          storedConversationId = null;
        }),
      } as unknown as Storage,
    } as Partial<Window>);
    const timeoutCalls: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      timeoutCalls.push(milliseconds);
      return new AbortController().signal;
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/conversations")) {
        return {
          ok: true,
          json: async () => ({ conversation: { id: "fresh-conversation" } }),
        };
      }
      return { ok: false, status: 404 };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new AgentWeb().chat({ text: "hello" })).rejects.toThrow(
      "Chat request failed: 404",
    );
    expect(timeoutCalls).toEqual([120_000, 30_000, 120_000]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid request timeout %s before fetch",
    async (timeoutMs) => {
      setWindow({
        __ELIZAOS_APP_BOOT_CONFIG__: { apiBase: "https://agent.example" },
      } as Partial<Window>);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        new AgentWeb().request({ path: "/api/status", timeoutMs }),
      ).rejects.toThrow("timeoutMs must be a finite positive number");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("keeps the request deadline active while the response body stalls", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Loopback server did not expose a TCP address");
    }
    setWindow({
      __ELIZAOS_APP_BOOT_CONFIG__: {
        apiBase: `http://127.0.0.1:${address.port}`,
      },
    } as Partial<Window>);

    try {
      await expect(
        new AgentWeb().request({ path: "/stall", timeoutMs: 50 }),
      ).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("aborts when a connected server never sends response headers", async () => {
    const server = createServer(() => {
      // Deliberately accept the socket without sending a response head.
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Loopback server did not expose a TCP address");
    }
    setWindow({
      __ELIZAOS_APP_BOOT_CONFIG__: {
        apiBase: `http://127.0.0.1:${address.port}`,
      },
    } as Partial<Window>);

    try {
      await expect(
        new AgentWeb().request({ path: "/stall", timeoutMs: 50 }),
      ).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails closed for local-agent IPC base in the web fallback", async () => {
    setWindow({
      __ELIZAOS_APP_BOOT_CONFIG__: { apiBase: "eliza-local-agent://ipc" },
    } as Partial<Window>);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new AgentWeb().request({ path: "/api/status" }),
    ).resolves.toEqual({
      status: 503,
      statusText: "Service Unavailable",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: "native_agent_unavailable",
        message:
          "Agent web fallback cannot handle eliza-local-agent://ipc; use the native Capacitor Agent plugin",
      }),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
