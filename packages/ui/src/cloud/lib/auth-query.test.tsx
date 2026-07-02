// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The query gate every cloud domain shares (analytics, api-keys, mcps,
// applications, approvals, instances) must resolve the session the same way
// the rest of the console does. Gating on the raw Steward SDK context (whose
// MemoryStorage session is empty on every full page load) left a gate
// permanently disabled for a signed-in user — analytics stuck on its loading
// skeleton, keys never fetched (#11558). These tests reproduce the
// page-reload reality: ONLY a persisted localStorage JWT, no Steward provider
// mounted.

import { useAuthenticatedQueryGate } from "./auth-query";

function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

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

beforeEach(() => {
  storage = createMemoryStorage();
  vi.stubGlobal("localStorage", storage);
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shared cloud query gate — session from persisted JWT only (page-reload reality)", () => {
  it("enables the query and exposes the user id when a valid JWT is persisted", () => {
    storage.setItem(
      "steward_session_token",
      makeJwt({ userId: "u1", exp: Math.floor(Date.now() / 1000) + 600 }),
    );

    const { result } = renderHook(() => useAuthenticatedQueryGate());

    expect(result.current.enabled).toBe(true);
    expect(result.current.userId).toBe("u1");
  });

  it("stays disabled with no persisted session", () => {
    const { result } = renderHook(() => useAuthenticatedQueryGate());
    expect(result.current.enabled).toBe(false);
  });

  it("stays disabled for an expired token", () => {
    storage.setItem(
      "steward_session_token",
      makeJwt({ userId: "u1", exp: Math.floor(Date.now() / 1000) - 600 }),
    );

    const { result } = renderHook(() => useAuthenticatedQueryGate());
    expect(result.current.enabled).toBe(false);
  });

  it("stays disabled when the caller's own enabled flag is false", () => {
    storage.setItem(
      "steward_session_token",
      makeJwt({ userId: "u1", exp: Math.floor(Date.now() / 1000) + 600 }),
    );

    const { result } = renderHook(() => useAuthenticatedQueryGate(false));
    expect(result.current.enabled).toBe(false);
  });
});
