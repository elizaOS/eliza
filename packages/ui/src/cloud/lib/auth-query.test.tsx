// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capacitorState = vi.hoisted(() => ({ isNative: false }));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => capacitorState.isNative,
  },
}));

// The query gate every cloud domain shares (analytics, api-keys, mcps,
// applications, approvals, instances) must resolve the session the same way
// the rest of the console does. Gating on the raw Steward SDK context (whose
// MemoryStorage session is empty on every full page load) left a gate
// permanently disabled for a signed-in user — analytics stuck on its loading
// skeleton, keys never fetched (#11558). These tests reproduce the
// page-reload reality: ONLY a persisted localStorage JWT, no Steward provider
// mounted.

import { setBootConfig } from "../../config/boot-config";
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
  capacitorState.isNative = false;
  setBootConfig({ branding: {}, apiToken: undefined });
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

  it("native: enables queries for an API-key session with no Steward JWT", () => {
    capacitorState.isNative = true;
    setBootConfig({ branding: {}, apiToken: "eliza_native_owner_key" });

    const { result } = renderHook(() => useAuthenticatedQueryGate());

    expect(result.current.enabled).toBe(true);
    expect(result.current.userId).toMatch(/^native-api-key:/);
  });

  it("native: ignores a local-agent bearer token in boot config", () => {
    capacitorState.isNative = true;
    setBootConfig({ branding: {}, apiToken: "local-agent-bearer-token" });

    const { result } = renderHook(() => useAuthenticatedQueryGate());

    expect(result.current.enabled).toBe(false);
    expect(result.current.userId).toBeNull();
  });

  it("native: ignores a non-JWT (non-cloud) steward token", () => {
    capacitorState.isNative = true;
    localStorage.setItem(
      "steward_session_token",
      "legacy-local-agent-bearer-token",
    );

    const { result } = renderHook(() => useAuthenticatedQueryGate());

    expect(result.current.enabled).toBe(false);
    expect(result.current.userId).toBeNull();
  });

  it("native: refreshes the API-key session when the token sync event fires in the same view", () => {
    capacitorState.isNative = true;

    const { result } = renderHook(() => useAuthenticatedQueryGate());
    expect(result.current.enabled).toBe(false);

    setBootConfig({ branding: {}, apiToken: "eliza_native_owner_key" });
    act(() => {
      window.dispatchEvent(new CustomEvent("steward-token-sync"));
    });

    expect(result.current.enabled).toBe(true);
    expect(result.current.userId).toMatch(/^native-api-key:/);
  });

  it("web: does not treat the REST API key as a session", () => {
    setBootConfig({ branding: {}, apiToken: "eliza_web_owner_key" });

    const { result } = renderHook(() => useAuthenticatedQueryGate());

    expect(result.current.enabled).toBe(false);
    expect(result.current.userId).toBeNull();
  });

  it("native: an expired Steward JWT does not block the API-key session gate", () => {
    capacitorState.isNative = true;
    storage.setItem(
      "steward_session_token",
      makeJwt({ userId: "u1", exp: Math.floor(Date.now() / 1000) - 600 }),
    );
    setBootConfig({ branding: {}, apiToken: "eliza_native_owner_key" });

    const { result } = renderHook(() => useAuthenticatedQueryGate());

    expect(result.current.enabled).toBe(true);
    expect(result.current.userId).toMatch(/^native-api-key:/);
  });
});
