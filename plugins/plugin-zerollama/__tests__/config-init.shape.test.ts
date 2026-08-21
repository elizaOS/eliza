/** Deterministic unit tests for base-URL/endpoint resolution and the init validation fetch (fetch mocked, no live server). */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { shouldEnable } from "../auto-enable";
import { OLLAMA_INIT_PROBE_TIMEOUT_MS, ollamaPlugin } from "../plugin";
import { getApiBase, getBaseURL, getSetting } from "../utils/config";

function runtime(settings: Record<string, string | undefined> = {}): IAgentRuntime {
  return {
    getSetting: vi.fn((key: string) => settings[key] ?? null),
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

  it("exports OLLAMA_INIT_PROBE_TIMEOUT_MS and attaches signal to self-test url validation probe", async () => {
    expect(OLLAMA_INIT_PROBE_TIMEOUT_MS).toBe(5_000);

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ models: [] })));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const urlTest = ollamaPlugin.tests?.[0]?.tests?.find(
        (t) => t.name === "ollama_test_url_validation"
      );
      expect(urlTest).toBeDefined();

      const testRuntime = runtime({ OLLAMA_BASE_URL: "http://remote:11434" });
      await urlTest?.fn(testRuntime);

      expect(fetchMock).toHaveBeenCalledWith(
        "http://remote:11434/api/tags",
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
