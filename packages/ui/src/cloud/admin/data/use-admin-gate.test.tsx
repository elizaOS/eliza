// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The admin gate must resolve the session the same way the rest of the console
// does. The Steward SDK context keeps its session in MemoryStorage — empty on
// every full page load — so gating on the raw context locked fully signed-in
// users out with "Sign in required" while billing/org rendered fine off the
// localStorage JWT. These tests exercise the gate with ONLY the persisted
// token present (no Steward provider mounted), which is the reload reality.

import { useAdminGate } from "./use-admin-gate";

function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

// Node ≥22's bare localStorage global is non-functional under vitest and
// shadows jsdom's — install a working in-memory Storage on both access paths.
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

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

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

describe("useAdminGate session resolution (no Steward provider mounted — the page-reload reality)", () => {
  it("sees a session that exists only as the persisted localStorage JWT", async () => {
    storage.setItem(
      "steward_session_token",
      makeJwt({ userId: "u1", exp: Math.floor(Date.now() / 1000) + 600 }),
    );

    const { result } = renderHook(() => useAdminGate(), { wrapper });

    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
  });

  it("stays signed-out with no persisted token", async () => {
    const { result } = renderHook(() => useAdminGate(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAuthenticated).toBe(false);
  });

  it("treats an expired persisted token as signed-out", async () => {
    storage.setItem(
      "steward_session_token",
      makeJwt({ userId: "u1", exp: Math.floor(Date.now() / 1000) - 600 }),
    );

    const { result } = renderHook(() => useAdminGate(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAuthenticated).toBe(false);
  });
});
