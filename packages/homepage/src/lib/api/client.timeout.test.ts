/**
 * elizacloudFetch deadlines — proves the production helper aborts on timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ELIZACLOUD_FETCH_TIMEOUT_MS, elizacloudFetch } from "./client";

describe("elizacloudFetch timeout", () => {
  const originalFetch = globalThis.fetch;
  let origTimeout: typeof AbortSignal.timeout;

  beforeEach(() => {
    origTimeout = AbortSignal.timeout.bind(AbortSignal);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("exposes the documented 10s budget", () => {
    expect(DEFAULT_ELIZACLOUD_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("aborts a stalled fetch at the deadline", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing");
        if (sig.aborted) {
          reject(sig.reason);
          return;
        }
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      await expect(elizacloudFetch("/api/test")).rejects.toMatchObject({
        name: "TimeoutError",
      });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("api.eliza.app"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("merges a caller signal via AbortSignal.any", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const anySpy = vi.spyOn(AbortSignal, "any");
    const controller = new AbortController();
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing merge");
        if (sig.aborted) {
          reject(sig.reason);
          return;
        }
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const pending = elizacloudFetch("/api/test", {
        signal: controller.signal,
      } as RequestInit);
      controller.abort(new DOMException("caller abort", "AbortError"));
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(anySpy).toHaveBeenCalledWith(
        expect.arrayContaining([controller.signal, expect.any(AbortSignal)]),
      );
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("sends the abort signal and succeeds on a fast upstream", async () => {
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.signal) throw new Error("signal missing success");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const result = await elizacloudFetch<{ ok: boolean }>("/api/test");
      expect(result).toEqual({ ok: true });
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("surfaces a provider error from a completed upstream", async () => {
    const spy = vi.fn(
      async () => new Response("Service Unavailable", { status: 503 }),
    );
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      await expect(elizacloudFetch("/api/test")).rejects.toThrow(
        "elizacloud API error 503",
      );
    } finally {
      globalThis.fetch = prev;
    }
  });
});
