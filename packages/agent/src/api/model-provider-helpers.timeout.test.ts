/**
 * OpenRouter + Anthropic catalog fetch deadlines — proves the provider aborts
 * on timeout via mocked hanging fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ANTHROPIC_CATALOG_FETCH_TIMEOUT_MS,
  DEFAULT_OPENROUTER_FETCH_TIMEOUT_MS,
  fetchAnthropicModels,
  fetchOpenRouterModels,
} from "./model-provider-helpers";

describe("model-provider-helpers fetch timeout", () => {
  let origTimeout: typeof AbortSignal.timeout;

  beforeEach(() => {
    origTimeout = AbortSignal.timeout.bind(AbortSignal);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes the documented 10s budgets", () => {
    expect(DEFAULT_OPENROUTER_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_ANTHROPIC_CATALOG_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("aborts a stalled OpenRouter fetch at the deadline", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing openrouter");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const pending = fetchOpenRouterModels("test-key");
      await expect(pending).resolves.toEqual([]);
      // At least one of the two parallel fetches should have been aborted; spy should have been called with signal
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("openrouter.ai"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("aborts a stalled Anthropic catalog fetch at the deadline", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing anthropic");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const result = await fetchAnthropicModels("test-key");
      expect(result).toEqual([]);
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("api.anthropic.com"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("sends the abort signal and succeeds on a fast upstream", async () => {
    const spy = vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.signal) throw new Error("signal missing success");
      if (url.includes("openrouter.ai")) {
        return new Response(
          JSON.stringify({ data: [{ id: "openai/gpt-4", name: "GPT-4" }] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({
          data: [{ id: "claude-3", display_name: "Claude 3" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const result = await fetchAnthropicModels("key");
      expect(result[0].id).toBe("claude-3");
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("surfaces a provider error from a completed upstream (null fallback)", async () => {
    const spy = vi.fn(
      async () => new Response("Service Unavailable", { status: 503 }),
    );
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const result = await fetchAnthropicModels("key");
      expect(result).toEqual([]);
      const orResult = await fetchOpenRouterModels("key");
      expect(orResult).toEqual([]);
    } finally {
      globalThis.fetch = prev;
    }
  });
});
