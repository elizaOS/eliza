/**
 * Unit tests for the `AgentWeb` HTTP fallback. `window` and `fetch` are
 * stubbed; the hang case is a never-settling fetch that rejects when the
 * production AbortSignal aborts.
 */
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
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("times out a hung Agent.request hop instead of waiting forever", async () => {
    setWindow({
      __ELIZAOS_APP_BOOT_CONFIG__: { apiBase: "https://agent.example" },
    } as Partial<Window>);
    const fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const started = performance.now();
    try {
      await new AgentWeb().request({ path: "/api/status", timeoutMs: 50 });
      expect.unreachable("hung request should fail closed");
    } catch (error) {
      expect((error as Error).name).toBe("TimeoutError");
    }
    expect(fetchMock).toHaveBeenCalledWith(
      "https://agent.example/api/status",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("attaches AbortSignal to getStatus fetch", async () => {
    setWindow({
      __ELIZAOS_APP_BOOT_CONFIG__: { apiBase: "https://agent.example" },
    } as Partial<Window>);
    const fetchMock = vi.fn(async () => ({
      json: async () => ({
        state: "running",
        agentName: "eliza",
        port: 1,
        startedAt: 1,
        error: null,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    await new AgentWeb().getStatus();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://agent.example/api/status",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
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
