import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { apiFetch, getAccessToken } from "./api-fetch";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;

function setWindow(getAccessToken?: () => Promise<string | null>) {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __privyGetAccessToken: getAccessToken,
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
        clear: () => {
          storage.clear();
        },
        key: (index: number) => Array.from(storage.keys())[index] ?? null,
        get length() {
          return storage.size;
        },
      },
    },
  });
}

describe("apiFetch", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
    setWindow();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  it("returns null when the access token getter rejects", async () => {
    setWindow(() =>
      Promise.reject({
        code: "session_expired",
        message: "Session expired",
        stack: "stack",
      }),
    );

    await expect(getAccessToken()).resolves.toBeNull();
  });

  it("still performs the request when token retrieval rejects", async () => {
    const fetchMock = mock((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setWindow(() =>
      Promise.reject({
        code: "session_expired",
        message: "Session expired",
        stack: "stack",
      }),
    );

    const response = await apiFetch("/api/users/me");

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe("include");
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("Authorization"),
    ).toBe(false);
  });
});
