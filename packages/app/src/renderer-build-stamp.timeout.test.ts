// Ensure window/document exist before the stamp module's auto-invocation
if (
  typeof (globalThis as unknown as { window?: unknown }).window === "undefined"
) {
  (globalThis as unknown as { window: unknown }).window = {
    location: { origin: "http://localhost:5173" },
    __ELIZA_RENDERER_BUILD__: undefined,
  } as unknown as Window;
}
if (
  typeof (globalThis as unknown as { document?: unknown }).document ===
  "undefined"
) {
  (globalThis as unknown as { document: unknown }).document = {
    baseURI: "http://localhost:5173/",
    getElementById: () => null,
  } as unknown as Document;
}

/**
 * Renderer build stamp fetch deadline — proves the production fetch aborts on timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RENDERER_BUILD_STAMP_FETCH_TIMEOUT_MS,
  loadRendererBuildStamp,
} from "./renderer-build-stamp";

describe("loadRendererBuildStamp fetch timeout", () => {
  const originalFetch = globalThis.fetch;
  let origTimeout: typeof AbortSignal.timeout;

  beforeEach(() => {
    origTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.stubEnv("DEV", false);
    // mock window and document for Node env
    (globalThis as unknown as { window: unknown }).window = {
      location: { origin: "http://localhost:5173" },
      __ELIZA_RENDERER_BUILD__: undefined,
    } as unknown as Window;
    (globalThis as unknown as { document: unknown }).document = {
      baseURI: "http://localhost:5173/",
      getElementById: () => null,
    } as unknown as Document;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("exposes the documented 5s budget", () => {
    expect(DEFAULT_RENDERER_BUILD_STAMP_FETCH_TIMEOUT_MS).toBe(5_000);
  });

  it("aborts a stalled manifest fetch at the deadline", async () => {
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
      const result = await loadRendererBuildStamp();
      expect(result).toBeNull();
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("eliza-renderer-build.json"),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          cache: "no-store",
        }),
      );
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("sends the abort signal and succeeds on a fast upstream", async () => {
    const stamp = {
      schema: "1",
      buildId: "abc123def456",
      indexHtmlSha256: "deadbeef",
      assetCount: 10,
      builtAt: "2026-01-01T00:00:00Z",
      commit: "abc",
      variant: "web",
      capacitorTarget: null,
      runtimeMode: null,
      playwrightTestAuth: false,
    };
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.signal) throw new Error("signal missing success");
      return new Response(JSON.stringify(stamp), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const result = await loadRendererBuildStamp();
      expect(result).toMatchObject({ buildId: "abc123def456" });
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("returns null on 404 and still uses timeout signal", async () => {
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.signal) throw new Error("signal missing 404");
      return new Response("Not Found", { status: 404 });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const result = await loadRendererBuildStamp();
      expect(result).toBeNull();
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      globalThis.fetch = prev;
    }
  });
});
