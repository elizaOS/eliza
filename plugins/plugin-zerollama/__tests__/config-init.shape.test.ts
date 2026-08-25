/**
 * Deterministic unit tests for base-URL/endpoint resolution, init validation fetch,
 * and loopback timeout abort handling for plugin self-tests.
 */
import http from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { shouldEnable } from "../auto-enable";
import { OLLAMA_INIT_PROBE_TIMEOUT_MS, ollamaPlugin } from "../plugin";
import { getApiBase, getBaseURL, getSetting } from "../utils/config";

function runtime(settings: Record<string, string | undefined> = {}): IAgentRuntime {
  return {
    getSetting: vi.fn((key: string) => settings[key] ?? null),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
}

describe("Ollama config and init plumbing", () => {
  it("uses OLLAMA_BASE_URL consistently with auto-enable", () => {
    expect(shouldEnable({ env: { OLLAMA_BASE_URL: "http://remote:11434" } })).toBe(true);
    expect(getBaseURL(runtime({ OLLAMA_BASE_URL: "http://remote:11434" }))).toBe(
      "http://remote:11434/api"
    );
    expect(getApiBase(runtime({ OLLAMA_BASE_URL: "http://remote:11434/api" }))).toBe(
      "http://remote:11434"
    );
  });

  it("keeps endpoint precedence over base URL", () => {
    expect(
      getBaseURL(
        runtime({
          OLLAMA_API_ENDPOINT: "http://endpoint:11434/api",
          OLLAMA_API_URL: "http://api-url:11434",
          OLLAMA_BASE_URL: "http://base-url:11434",
        })
      )
    ).toBe("http://endpoint:11434/api");
  });

  it("trims settings before resolving URLs and falls back from blank values", () => {
    expect(
      getBaseURL(
        runtime({
          OLLAMA_API_ENDPOINT: "   ",
          OLLAMA_API_URL: " http://api-url:11434/api ",
        })
      )
    ).toBe("http://api-url:11434/api");
    expect(getApiBase(runtime({ OLLAMA_BASE_URL: " http://remote:11434/ " }))).toBe(
      "http://remote:11434"
    );
  });

  it("falls through a blank runtime override to the environment and default", () => {
    const previous = process.env.OLLAMA_BASE_URL;
    try {
      process.env.OLLAMA_BASE_URL = " http://env-host:11434 ";
      expect(getSetting(runtime({ OLLAMA_BASE_URL: "   " }), "OLLAMA_BASE_URL", "fallback")).toBe(
        "http://env-host:11434"
      );
      delete process.env.OLLAMA_BASE_URL;
      expect(getSetting(runtime({ OLLAMA_BASE_URL: "" }), "OLLAMA_BASE_URL", "fallback")).toBe(
        "fallback"
      );
    } finally {
      if (previous === undefined) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = previous;
    }
  });

  it("does not throw when init validation fetch fails with a non-Error value", async () => {
    const fetchMock = vi.fn(async () => {
      throw "socket closed";
    });
    const initRuntime = {
      ...runtime({ OLLAMA_BASE_URL: " http://remote:11434 " }),
      fetch: fetchMock,
    } as unknown as IAgentRuntime & { fetch: typeof fetch };

    await expect(ollamaPlugin.init?.({}, initRuntime)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://remote:11434/api/tags",
      expect.objectContaining({
        method: "GET",
        headers: { "Content-Type": "application/json" },
      })
    );
  });

  it("uses runtime.fetch for init validation and host-flavor probe", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (href.endsWith("/api/version")) {
        return new Response(JSON.stringify({ version: "0.0.0" }));
      }
      return new Response(JSON.stringify({ models: [] }));
    });
    const initRuntime = {
      ...runtime({ OLLAMA_BASE_URL: "http://remote:11434" }),
      fetch: fetchMock,
    } as unknown as IAgentRuntime & { fetch: typeof fetch };

    await expect(ollamaPlugin.init?.({}, initRuntime)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://remote:11434/api/tags",
      expect.objectContaining({
        method: "GET",
        headers: { "Content-Type": "application/json" },
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://remote:11434/api/version",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("exports OLLAMA_INIT_PROBE_TIMEOUT_MS with 5-second bound", () => {
    expect(OLLAMA_INIT_PROBE_TIMEOUT_MS).toBe(5_000);
  });

  it("aborts a stalled url validation probe via real loopback server and reports diagnostic error", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const server = http.createServer((_req, _res) => {
      // Intentionally stall response headers
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as import("node:net").AddressInfo;
    const port = addr.port;

    const reportErrorMock = vi.fn();
    const testRuntime = {
      ...runtime({ OLLAMA_BASE_URL: `http://127.0.0.1:${port}` }),
      reportError: reportErrorMock,
    } as unknown as IAgentRuntime;

    const originalSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((handler, timeout, ...args) =>
        originalSetTimeout(
          handler,
          timeout === OLLAMA_INIT_PROBE_TIMEOUT_MS ? 50 : timeout,
          ...args
        )) as typeof globalThis.setTimeout);

    try {
      const urlTest = ollamaPlugin.tests?.[0]?.tests?.find(
        (t) => t.name === "ollama_test_url_validation"
      );
      expect(urlTest).toBeDefined();

      const start = Date.now();
      await expect(urlTest?.fn(testRuntime)).resolves.toBeUndefined();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(4_000);
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), OLLAMA_INIT_PROBE_TIMEOUT_MS);
      expect(reportErrorMock).toHaveBeenCalledTimes(1);
      expect(reportErrorMock).toHaveBeenCalledWith(
        "plugin-zerollama.test.url-validation",
        expect.objectContaining({ name: "TimeoutError" })
      );
    } finally {
      timeoutSpy.mockRestore();
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("completes cleanly when the loopback endpoint responds successfully", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as import("node:net").AddressInfo;
    const port = addr.port;

    const reportErrorMock = vi.fn();
    const testRuntime = {
      ...runtime({ OLLAMA_BASE_URL: `http://127.0.0.1:${port}` }),
      reportError: reportErrorMock,
    } as unknown as IAgentRuntime;

    try {
      const urlTest = ollamaPlugin.tests?.[0]?.tests?.find(
        (t) => t.name === "ollama_test_url_validation"
      );
      expect(urlTest).toBeDefined();

      await expect(urlTest?.fn(testRuntime)).resolves.toBeUndefined();
      expect(reportErrorMock).not.toHaveBeenCalled();
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
