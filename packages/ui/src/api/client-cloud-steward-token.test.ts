/** Verifies getCloudAuthToken (Cloud = Steward everywhere) through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Unit coverage for reading the Steward session token, computing its
 * seconds-remaining from the JWT `exp`, the cookie-backed Steward refresh
 * (web/fetch branch — native/Electrobun HTTP has its own dedicated coverage),
 * and the cloud web/API host-normalization helpers. Tokens hand-built, no
 * live cloud.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import {
  cloudTokenSecsRemaining,
  getCloudAuthToken,
  refreshCloudStewardSession,
  resolveDirectCloudAppBase,
  resolveDirectCloudAuthApiBase,
  resolveDirectCloudWebBase,
} from "./client-cloud";

const STEWARD_TOKEN_KEY = "steward_session_token";

function makeJwt(exp: number | null): string {
  const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const payload = btoa(JSON.stringify(exp === null ? {} : { exp }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${header}.${payload}.sig`;
}

describe("getCloudAuthToken (Cloud = Steward everywhere)", () => {
  beforeEach(() => {
    localStorage.removeItem(STEWARD_TOKEN_KEY);
  });

  afterEach(() => {
    localStorage.removeItem(STEWARD_TOKEN_KEY);
  });

  it("prefers the Steward session token over the client REST token", () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "steward-jwt");
    const client = new ElizaClient();
    client.setToken("client-token");
    expect(getCloudAuthToken(client)).toBe("steward-jwt");
    client.setToken(null);
  });

  it("resolves the device-code/Remote session token from the steward store", () => {
    // The device-code/pairing flow persists its session token through the same
    // steward-session store, so it resolves via the canonical Steward branch.
    localStorage.setItem(STEWARD_TOKEN_KEY, "device-code-token");
    expect(getCloudAuthToken()).toBe("device-code-token");
  });

  it("falls back to the client REST token last", () => {
    const client = new ElizaClient();
    client.setToken("client-token");
    expect(getCloudAuthToken(client)).toBe("client-token");
    client.setToken(null);
  });

  it("dispatches steward-token-sync when the client REST token changes", () => {
    const listener = vi.fn();
    window.addEventListener("steward-token-sync", listener);
    const client = new ElizaClient();

    client.setToken("client-token");
    client.setToken(null);

    window.removeEventListener("steward-token-sync", listener);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("returns null when no token is available anywhere", () => {
    expect(getCloudAuthToken()).toBeNull();
  });

  it("dispatches steward-token-sync on setToken so mounted gates refresh (#12046 Nit 2)", () => {
    const client = new ElizaClient();
    let syncs = 0;
    const handler = () => {
      syncs++;
    };
    window.addEventListener("steward-token-sync", handler);
    try {
      client.setToken("client-token");
      client.setToken(null);
      // Both the sign-in and the sign-out write must notify listeners — before
      // the fix setToken dispatched nothing and the gate went stale until a
      // remount.
      expect(syncs).toBe(2);
    } finally {
      window.removeEventListener("steward-token-sync", handler);
    }
  });
});

describe("cloudTokenSecsRemaining", () => {
  it("returns seconds remaining for a JWT with exp", () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const secs = cloudTokenSecsRemaining(makeJwt(exp));
    expect(secs).not.toBeNull();
    expect(secs as number).toBeGreaterThan(500);
    expect(secs as number).toBeLessThanOrEqual(600);
  });

  it("returns null for a JWT without exp", () => {
    expect(cloudTokenSecsRemaining(makeJwt(null))).toBeNull();
  });

  it("returns null for a non-JWT opaque token", () => {
    expect(cloudTokenSecsRemaining("opaque-device-code-token")).toBeNull();
  });
});

describe("resolveDirectCloudWebBase / resolveDirectCloudAuthApiBase", () => {
  it("maps a known API host to the browser-navigable web host", () => {
    expect(resolveDirectCloudWebBase("https://api.elizacloud.ai")).toBe(
      "https://eliza.app",
    );
  });

  it("maps a staging API host to the staging web host", () => {
    expect(resolveDirectCloudWebBase("https://api-staging.elizacloud.ai")).toBe(
      "https://staging.eliza.app",
    );
  });

  it("passes through an unmapped host unchanged (trailing slash trimmed)", () => {
    expect(resolveDirectCloudWebBase("https://example.com/")).toBe(
      "https://example.com",
    );
  });

  it("trims a 100k trailing slash run without changing the prefix", () => {
    expect(
      resolveDirectCloudWebBase(`https://example.com${"/".repeat(100_000)}`),
    ).toBe("https://example.com");
  });

  it("falls back to the raw input for an unparseable base", () => {
    expect(resolveDirectCloudWebBase("not a url")).toBe("not a url");
  });

  it("maps a known site host to its API host", () => {
    expect(resolveDirectCloudAuthApiBase("https://www.elizacloud.ai")).toBe(
      "https://api.eliza.app",
    );
  });

  it("passes through an unmapped host unchanged for the auth API base", () => {
    expect(resolveDirectCloudAuthApiBase("https://example.com")).toBe(
      "https://example.com",
    );
  });

  it("falls back to the raw input for an unparseable auth API base", () => {
    expect(resolveDirectCloudAuthApiBase("not a url")).toBe("not a url");
  });

  it("keeps management navigation on the canonical Cloud app host", () => {
    expect(resolveDirectCloudAppBase("https://api.elizacloud.ai")).toBe(
      "https://cloud.eliza.app",
    );
    expect(resolveDirectCloudAppBase("https://staging.elizacloud.ai")).toBe(
      "https://cloud-staging.eliza.app",
    );
  });
});

describe("refreshCloudStewardSession (web/fetch branch)", () => {
  // Not native and not Electrobun in jsdom — shouldUseNativeStewardRefreshHttp
  // is false, so every case here exercises the plain `fetch` + credentials
  // branch, mirroring cloud-frontend's AuthTokenSync.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs with credentials included and returns the rotated token payload", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: "rotated-jwt", expiresIn: 900 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshCloudStewardSession({
      endpoint: "https://api.elizacloud.ai/api/v1/auth/steward/refresh",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.elizacloud.ai/api/v1/auth/steward/refresh",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toEqual({ token: "rotated-jwt", expiresIn: 900 });
  });

  it("returns null when the refresh endpoint responds non-OK (no rotated cookie)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    const result = await refreshCloudStewardSession({
      endpoint: "https://api.elizacloud.ai/api/v1/auth/steward/refresh",
    });
    expect(result).toBeNull();
  });

  it("surfaces a typed transient failure when the caller must preserve auth state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503 })),
    );

    await expect(
      refreshCloudStewardSession({
        endpoint: "https://api.elizacloud.ai/api/v1/auth/steward/refresh",
        throwOnTransientHttpFailure: true,
      }),
    ).rejects.toMatchObject({
      code: "STEWARD_SESSION_REFRESH_TRANSIENT",
      context: {
        endpoint: "https://api.elizacloud.ai/api/v1/auth/steward/refresh",
        status: 503,
      },
    });
  });

  it("treats a malformed 2xx body as transient when the caller must preserve auth state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      })),
    );

    await expect(
      refreshCloudStewardSession({
        endpoint: "https://api.elizacloud.ai/api/v1/auth/steward/refresh",
        throwOnTransientHttpFailure: true,
      }),
    ).rejects.toMatchObject({
      code: "STEWARD_SESSION_REFRESH_TRANSIENT",
      context: {
        endpoint: "https://api.elizacloud.ai/api/v1/auth/steward/refresh",
        status: 200,
      },
    });
  });

  it("treats an empty 2xx body as transient when the caller must preserve auth state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
    );

    await expect(
      refreshCloudStewardSession({
        endpoint: "https://api.elizacloud.ai/api/v1/auth/steward/refresh",
        throwOnTransientHttpFailure: true,
      }),
    ).rejects.toMatchObject({
      code: "STEWARD_SESSION_REFRESH_TRANSIENT",
    });
  });

  it("returns null when the response body is not parseable JSON (J3 fail-closed)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      })),
    );
    const result = await refreshCloudStewardSession({
      endpoint: "https://api.elizacloud.ai/api/v1/auth/steward/refresh",
    });
    expect(result).toBeNull();
  });
});

describe("refreshCloudStewardSession timeouts (portable fallback, fake timers)", () => {
  const ENDPOINT = "https://api.elizacloud.ai/api/v1/auth/steward/refresh";
  const TIMEOUT_MS = 30_000;
  let originalTimeout: unknown;

  beforeEach(() => {
    // Force the AbortController+setTimeout fallback so fake timers control the
    // timeout deterministically. Native AbortSignal.timeout uses an internal
    // timer not governed by vi.useFakeTimers() in all runtimes, so forcing
    // fallback makes the 30 s contract testable.
    originalTimeout = (AbortSignal as unknown as { timeout?: unknown }).timeout;
    Object.defineProperty(AbortSignal, "timeout", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Object.defineProperty(AbortSignal, "timeout", {
      value: originalTimeout,
      configurable: true,
      writable: true,
    });
  });

  it("aborts a headers-stalled fetch at 30 s and maps to STEWARD_SESSION_REFRESH_TRANSIENT (throwOnTransient)", async () => {
    const fetchMock = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (signal?.aborted) {
            reject(new DOMException("TimeoutError", "TimeoutError"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("TimeoutError", "TimeoutError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = refreshCloudStewardSession({
      endpoint: ENDPOINT,
      throwOnTransientHttpFailure: true,
    });

    // Must NOT settle before the timeout fires.
    let settled = false;
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const signal = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)
      ?.signal as AbortSignal | undefined;
    expect(signal).toBeInstanceOf(AbortSignal);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    await expect(pending).rejects.toMatchObject({
      code: "STEWARD_SESSION_REFRESH_TRANSIENT",
      context: { endpoint: ENDPOINT },
    });
    // Timer is disposed after abort so success-before-timeout does not leak.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns null on headers stall when not in throwOnTransient mode (fail-closed)", async () => {
    const fetchMock = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("AbortError", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const pending = refreshCloudStewardSession({ endpoint: ENDPOINT });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await expect(pending).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a headers-received plus stalled body at 30 s (signal kept alive through json)", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal | undefined;
        return {
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              if (signal?.aborted) {
                reject(new DOMException("TimeoutError", "TimeoutError"));
                return;
              }
              signal?.addEventListener(
                "abort",
                () => reject(new DOMException("TimeoutError", "TimeoutError")),
                { once: true },
              );
            }),
        };
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = refreshCloudStewardSession({
      endpoint: ENDPOINT,
      throwOnTransientHttpFailure: true,
    });

    // Let the fetch resolve headers (microtask) but json stays pending.
    await Promise.resolve();
    await Promise.resolve();
    // Still pending before timeout.
    let settled = false;
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    await expect(pending).rejects.toMatchObject({
      code: "STEWARD_SESSION_REFRESH_TRANSIENT",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the pending timer on success before timeout (no leak under fake timers)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: "fresh-jwt", expiresIn: 900 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshCloudStewardSession({ endpoint: ENDPOINT });
    expect(result).toEqual({ token: "fresh-jwt", expiresIn: 900 });
    // dispose() cleared the fallback timer; no pending timers remain.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not mutate the global AbortSignal.timeout across tests (fallback proof)", () => {
    // This test proves the fallback path was exercised without leaking the
    // stub — the afterEach restores the original, so a later test sees the
    // native impl again.
    expect(
      (AbortSignal as unknown as { timeout?: unknown }).timeout,
    ).toBeUndefined();
  });
});
