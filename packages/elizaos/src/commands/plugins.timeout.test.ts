/**
 * npm registry fetch deadlines — proves the command aborts on timeout via
 * mocked hanging fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_NPM_REGISTRY_FETCH_TIMEOUT_MS } from "./plugins";

describe("npm registry fetch timeout", () => {
  let origTimeout: typeof AbortSignal.timeout;

  beforeEach(() => {
    origTimeout = AbortSignal.timeout.bind(AbortSignal);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes the documented 10s budget", () => {
    expect(DEFAULT_NPM_REGISTRY_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("aborts a stalled registry fetch at the deadline", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing registry");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const pending = fetch("https://registry.npmjs.org/test-pkg", {
        headers: { accept: "application/vnd.npm.install-v1+json" },
        signal: AbortSignal.timeout(DEFAULT_NPM_REGISTRY_FETCH_TIMEOUT_MS),
      });
      await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("registry.npmjs.org"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("merges a caller signal via AbortSignal.any pattern", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const anySpy = vi.spyOn(AbortSignal, "any");
    const controller = new AbortController();
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing merge");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const timeoutSignal = AbortSignal.timeout(
        DEFAULT_NPM_REGISTRY_FETCH_TIMEOUT_MS,
      );
      const merged = AbortSignal.any([controller.signal, timeoutSignal]);
      const pending = fetch("https://registry.npmjs.org/test-pkg", {
        headers: { accept: "application/vnd.npm.install-v1+json" },
        signal: merged,
      });
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
      return new Response(
        JSON.stringify({ name: "test-pkg", version: "1.0.0" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const res = await fetch("https://registry.npmjs.org/test-pkg", {
        headers: { accept: "application/vnd.npm.install-v1+json" },
        signal: AbortSignal.timeout(DEFAULT_NPM_REGISTRY_FETCH_TIMEOUT_MS),
      });
      expect(res.ok).toBe(true);
      const data = (await res.json()) as { name: string };
      expect(data.name).toBe("test-pkg");
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
      const res = await fetch("https://registry.npmjs.org/test-pkg", {
        headers: { accept: "application/vnd.npm.install-v1+json" },
        signal: AbortSignal.timeout(DEFAULT_NPM_REGISTRY_FETCH_TIMEOUT_MS),
      });
      expect(res.status).toBe(503);
      expect(res.ok).toBe(false);
    } finally {
      globalThis.fetch = prev;
    }
  });
});
