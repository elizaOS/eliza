/** Verifies useJoinSessionAuth session resolution: provider context, localStorage-JWT fallback, liveness, sync events, and the Playwright ready override. */
// @vitest-environment jsdom

/**
 * `useJoinSessionAuth` joins the Steward provider context with the persisted
 * localStorage JWT so the join page resolves auth before the heavy runtime
 * mounts. These tests drive the real hook against a memory-backed Storage and
 * a hand-built context provider — no fetches, no network.
 */

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LocalStewardAuthContext,
  type LocalStewardAuthValue,
} from "../../shell/StewardProviderShared";
import { useJoinSessionAuth } from "./use-join-session";

function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

const LIVE_EXP = () => Math.floor(Date.now() / 1000) + 600;

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
}

let storage: Storage;

function authValue(
  overrides: Partial<LocalStewardAuthValue> = {},
): LocalStewardAuthValue {
  return {
    isAuthenticated: false,
    isLoading: false,
    user: null,
    session: null,
    signOut: () => undefined,
    getToken: () => null,
    verifyEmailCallback: async () => ({ token: "" }),
    ...overrides,
  };
}

function wrapper(value: LocalStewardAuthValue | null) {
  return function ContextWrapper({ children }: { children: ReactNode }) {
    if (value === null) return <>{children}</>;
    return (
      <LocalStewardAuthContext.Provider value={value}>
        {children}
      </LocalStewardAuthContext.Provider>
    );
  };
}

const NO_PROVIDER = wrapper(null);

beforeEach(() => {
  storage = createMemoryStorage();
  vi.stubGlobal("localStorage", storage);
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useJoinSessionAuth", () => {
  it("reports unauthenticated and ready with no provider and empty storage", () => {
    const { result } = renderHook(() => useJoinSessionAuth(), {
      wrapper: NO_PROVIDER,
    });

    expect(result.current).toEqual({ ready: true, authenticated: false });
  });

  it("authenticates from a live persisted token without a provider", () => {
    storage.setItem(
      STEWARD_TOKEN_KEY,
      makeJwt({ userId: "u1", exp: LIVE_EXP() }),
    );

    const { result } = renderHook(() => useJoinSessionAuth(), {
      wrapper: NO_PROVIDER,
    });

    expect(result.current.authenticated).toBe(true);
    expect(result.current.ready).toBe(true);
  });

  it("treats an expired persisted token as unauthenticated", () => {
    storage.setItem(
      STEWARD_TOKEN_KEY,
      makeJwt({ userId: "u1", exp: Math.floor(Date.now() / 1000) - 600 }),
    );

    const { result } = renderHook(() => useJoinSessionAuth(), {
      wrapper: NO_PROVIDER,
    });

    expect(result.current.authenticated).toBe(false);
    expect(result.current.ready).toBe(true);
  });

  it("treats a token with no exp claim as live (the hook only rejects past exp)", () => {
    storage.setItem(STEWARD_TOKEN_KEY, makeJwt({ userId: "u1" }));

    const { result } = renderHook(() => useJoinSessionAuth(), {
      wrapper: NO_PROVIDER,
    });

    expect(result.current.authenticated).toBe(true);
  });

  it("treats a non-JWT string as unauthenticated", () => {
    storage.setItem(STEWARD_TOKEN_KEY, "not-a-jwt");

    const { result } = renderHook(() => useJoinSessionAuth(), {
      wrapper: NO_PROVIDER,
    });

    expect(result.current.authenticated).toBe(false);
  });

  it("treats a three-segment token with a garbage payload as unauthenticated", () => {
    const garbagePayload = btoa("this is not json")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    storage.setItem(STEWARD_TOKEN_KEY, `header.${garbagePayload}.signature`);

    const { result } = renderHook(() => useJoinSessionAuth(), {
      wrapper: NO_PROVIDER,
    });

    expect(result.current.authenticated).toBe(false);
  });

  it("is not ready while the Steward provider is still loading", () => {
    const { result } = renderHook(() => useJoinSessionAuth(), {
      wrapper: wrapper(authValue({ isLoading: true })),
    });

    expect(result.current.ready).toBe(false);
    expect(result.current.authenticated).toBe(false);
  });

  it("becomes ready once the provider finishes loading", () => {
    const { result } = renderHook(() => useJoinSessionAuth(), {
      wrapper: wrapper(authValue()),
    });

    expect(result.current.ready).toBe(true);
    expect(result.current.authenticated).toBe(false);
  });

  it("trusts an authenticated provider even when storage holds no token", () => {
    const { result } = renderHook(() => useJoinSessionAuth(), {
      wrapper: wrapper(authValue({ isAuthenticated: true })),
    });

    expect(result.current.authenticated).toBe(true);
    expect(result.current.ready).toBe(true);
  });

  it("keeps a live stored token authoritative for authentication while the provider loads", () => {
    storage.setItem(
      STEWARD_TOKEN_KEY,
      makeJwt({ userId: "u1", exp: LIVE_EXP() }),
    );

    const { result } = renderHook(() => useJoinSessionAuth(), {
      wrapper: wrapper(authValue({ isLoading: true })),
    });

    expect(result.current.ready).toBe(false);
    expect(result.current.authenticated).toBe(true);
  });

  it("treats the page as ready during provider loading when the Playwright test-auth override is enabled", () => {
    const previous = process.env.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH;
    process.env.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH = "true";
    try {
      const { result } = renderHook(() => useJoinSessionAuth(), {
        wrapper: wrapper(authValue({ isLoading: true })),
      });

      expect(result.current.ready).toBe(true);
      expect(result.current.authenticated).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH;
      } else {
        process.env.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH = previous;
      }
    }
  });

  it("reads as unauthenticated when localStorage access throws (fail-closed)", () => {
    vi.spyOn(storage, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });

    const { result } = renderHook(() => useJoinSessionAuth(), {
      wrapper: NO_PROVIDER,
    });

    expect(result.current.authenticated).toBe(false);
    expect(result.current.ready).toBe(true);
  });

  it("re-reads stored auth when a steward-token-sync event fires", () => {
    const { result } = renderHook(() => useJoinSessionAuth(), {
      wrapper: NO_PROVIDER,
    });
    expect(result.current.authenticated).toBe(false);

    act(() => {
      storage.setItem(
        STEWARD_TOKEN_KEY,
        makeJwt({ userId: "u-sync", exp: LIVE_EXP() }),
      );
      window.dispatchEvent(new Event("steward-token-sync"));
    });

    expect(result.current.authenticated).toBe(true);
  });

  it("drops authentication when a storage event follows token removal", () => {
    storage.setItem(
      STEWARD_TOKEN_KEY,
      makeJwt({ userId: "u-out", exp: LIVE_EXP() }),
    );

    const { result } = renderHook(() => useJoinSessionAuth(), {
      wrapper: NO_PROVIDER,
    });
    expect(result.current.authenticated).toBe(true);

    act(() => {
      storage.removeItem(STEWARD_TOKEN_KEY);
      window.dispatchEvent(new StorageEvent("storage"));
    });

    expect(result.current.authenticated).toBe(false);
  });

  it("picks up a token persisted after mount through its deferred re-check", () => {
    vi.useFakeTimers();
    try {
      const token = makeJwt({
        userId: "u-late",
        exp: Math.floor(Date.now() / 1000) + 600,
      });

      const { result } = renderHook(() => useJoinSessionAuth(), {
        wrapper: NO_PROVIDER,
      });
      expect(result.current.authenticated).toBe(false);

      act(() => {
        storage.setItem(STEWARD_TOKEN_KEY, token);
        vi.advanceTimersByTime(300);
      });

      expect(result.current.authenticated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
