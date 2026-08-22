/**
 * Tests for homepage elizacloud API fetch client.
 * Verifies request construction, auth token propagation, and signal
 * composition with AbortSignal.any joining caller signals and hop deadlines.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  elizacloudAuthFetch,
  elizacloudFetch,
  getAuthToken,
  getElizacloudUrl,
} from "../src/lib/api/client.ts";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalLocalStorage = (
  globalThis as unknown as { localStorage?: Storage }
).localStorage;

describe("elizacloud API client", () => {
  let mockStorage: Record<string, string> = {};

  beforeEach(() => {
    mockStorage = {};
    const storageImpl = {
      getItem: (key: string) => mockStorage[key] ?? null,
      setItem: (key: string, value: string) => {
        mockStorage[key] = value;
      },
      removeItem: (key: string) => {
        delete mockStorage[key];
      },
      clear: () => {
        mockStorage = {};
      },
      length: 0,
      key: () => null,
    };

    globalThis.window = {
      localStorage: storageImpl,
    } as unknown as Window & typeof globalThis;
    (globalThis as unknown as { localStorage: Storage }).localStorage =
      storageImpl as unknown as Storage;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow !== undefined) {
      globalThis.window = originalWindow;
    } else {
      delete (globalThis as unknown as { window?: Window }).window;
    }
    if (originalLocalStorage !== undefined) {
      (globalThis as unknown as { localStorage: Storage }).localStorage =
        originalLocalStorage;
    } else {
      delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
    }
  });

  it("returns base API url", () => {
    expect(getElizacloudUrl()).toBe("https://api.eliza.app");
  });

  it("fetches json successfully with default deadline signal", async () => {
    let observedSignal: AbortSignal | null | undefined;
    let observedUrl = "";

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      observedUrl = input.toString();
      observedSignal = init?.signal;
      return new Response(JSON.stringify({ ok: true, data: "hello" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const res = await elizacloudFetch<{ ok: boolean; data: string }>(
      "/v1/status",
      {
        params: { mode: "fast" },
      },
    );

    expect(res).toEqual({ ok: true, data: "hello" });
    expect(observedUrl).toBe("https://api.eliza.app/v1/status?mode=fast");
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(false);
  });

  it("composes caller signal with deadline via AbortSignal.any", async () => {
    const callerController = new AbortController();
    let passedSignal: AbortSignal | null | undefined;

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      passedSignal = init?.signal;
      if (init?.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return new Response(JSON.stringify({ done: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    // Caller aborts before/during execution
    callerController.abort(new Error("caller canceled"));

    expect(
      elizacloudFetch("/v1/task", {
        signal: callerController.signal,
      }),
    ).rejects.toThrow();

    expect(passedSignal?.aborted).toBe(true);
  });

  it("still aborts on the hop deadline when a caller signal is present", async () => {
    const callerController = new AbortController();
    const deadlineController = new AbortController();
    const originalTimeout = AbortSignal.timeout;

    AbortSignal.timeout = () => deadlineController.signal;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      })) as typeof fetch;

    try {
      const request = elizacloudFetch("/v1/task", {
        signal: callerController.signal,
      });
      deadlineController.abort(new DOMException("deadline", "TimeoutError"));

      await expect(request).rejects.toMatchObject({ name: "TimeoutError" });
      expect(callerController.signal.aborted).toBe(false);
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
  });

  it("attaches Bearer token in elizacloudAuthFetch when session token exists", async () => {
    mockStorage.eliza_app_session = "test-auth-token-123";
    let observedAuthHeader: string | undefined;

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const headers = init?.headers as Record<string, string>;
      observedAuthHeader = headers?.Authorization;
      return new Response(JSON.stringify({ user: "alice" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const res = await elizacloudAuthFetch<{ user: string }>("/v1/me");
    expect(res).toEqual({ user: "alice" });
    expect(observedAuthHeader).toBe("Bearer test-auth-token-123");
    expect(getAuthToken()).toBe("test-auth-token-123");
  });

  it("throws error with status and text when response is not ok", async () => {
    globalThis.fetch = (async () => {
      return new Response("Unauthorized resource", {
        status: 401,
        headers: { "Content-Type": "text/plain" },
      });
    }) as typeof fetch;

    expect(elizacloudFetch("/v1/protected")).rejects.toThrow(
      "elizacloud API error 401: Unauthorized resource",
    );
  });
});
