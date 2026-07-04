// @vitest-environment jsdom

/**
 * `AuthTokenSync` 401 handling in the Steward runtime: a still-valid token
 * survives a session-sync/refresh 401 (no re-login loop) and retries the cookie
 * sync on the next trigger, while a genuinely expired — or exp-less, thus
 * never-ageable — token is cleared on a refresh 401 so the session self-heals.
 */

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// AuthTokenSync's 401 handling is the load-bearing fix for the re-login loop:
// a 401 from session-sync or refresh must NOT wipe a still-valid token (a
// misrouted/stale control plane 401s valid sessions), but MUST still clear
// once the token is expired — and an exp-less token counts as expired, or no
// 401 could ever clear it. These tests exercise the real AuthTokenSync against
// a stubbed fetch; only the @stwd SDK boundary is mocked.

vi.mock("@stwd/react", () => ({
  StewardProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({
    isAuthenticated: false,
    isLoading: false,
    user: null,
    session: null,
    signOut: () => {},
    getToken: () => "",
    verifyEmailCallback: async () => ({ token: "" }),
  }),
}));
vi.mock("@stwd/react/styles.css", () => ({}));
vi.mock("@stwd/sdk", () => ({
  StewardClient: class {},
}));

import StewardAuthRuntimeProvider from "./StewardProviderRuntime";

function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

type RecordedCall = { url: string; method: string };
let calls: RecordedCall[] = [];

// Node ≥22 ships a bare `localStorage` global that is non-functional without
// --localstorage-file and shadows jsdom's Storage (its methods throw), and in
// this vitest setup even window.localStorage resolves to it. The code under
// test reads via both the bare global and window.localStorage, so install one
// in-memory Storage on both access paths.
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

let storage: Storage = createMemoryStorage();

function stubFetchWith401s(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (method === "DELETE") return new Response(null, { status: 200 });
      return new Response(JSON.stringify({}), { status: 401 });
    }),
  );
}

function postsTo(endpoint: string): RecordedCall[] {
  return calls.filter((c) => c.method === "POST" && c.url.includes(endpoint));
}

function mount() {
  return render(
    <StewardAuthRuntimeProvider apiUrl="https://steward.test">
      <div />
    </StewardAuthRuntimeProvider>,
  );
}

beforeEach(() => {
  calls = [];
  storage = createMemoryStorage();
  vi.stubGlobal("localStorage", storage);
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
  // Neutralize any configured API base so endpoints resolve to the relative
  // paths (unknown jsdom host) — the handlers under test are endpoint-agnostic.
  vi.stubEnv("VITE_API_URL", "");
  vi.stubEnv("NEXT_PUBLIC_API_URL", "");
  stubFetchWith401s();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("AuthTokenSync 401 handling", () => {
  it("keeps a still-valid token when session-sync and refresh both 401 (no re-login loop), then retries the cookie sync on the next trigger", async () => {
    // exp 60s out: valid, but inside the 120s refresh-ahead window so the
    // mount-time checkAndRefresh actually POSTs the refresh endpoint.
    const token = makeJwt({
      sub: "u1",
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    storage.setItem(STEWARD_TOKEN_KEY, token);

    mount();

    await waitFor(() => {
      expect(postsTo("steward-session").length).toBeGreaterThanOrEqual(1);
      expect(postsTo("steward-refresh").length).toBeGreaterThanOrEqual(1);
    });

    // Both endpoints 401'd — pre-fix this wiped the token and looped /login.
    expect(storage.getItem(STEWARD_TOKEN_KEY)).toBe(token);

    // The keep-path resets the sync dedupe marker, so the next trigger
    // re-attempts the cookie POST for the SAME token (the endpoint may have
    // healed). Without the reset this second POST never happens.
    const before = postsTo("steward-session").length;
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() =>
      expect(postsTo("steward-session").length).toBeGreaterThan(before),
    );
    expect(storage.getItem(STEWARD_TOKEN_KEY)).toBe(token);
  });

  it("clears an expired token on a refresh 401 (genuine end-of-session still self-heals)", async () => {
    storage.setItem(
      STEWARD_TOKEN_KEY,
      makeJwt({ sub: "u1", exp: Math.floor(Date.now() / 1000) - 60 }),
    );

    mount();

    await waitFor(() => expect(storage.getItem(STEWARD_TOKEN_KEY)).toBeNull());
  });

  it("clears an exp-less token on a refresh 401 (it can never age out, so it must not be keepable)", async () => {
    storage.setItem(STEWARD_TOKEN_KEY, makeJwt({ sub: "u1" }));

    mount();

    await waitFor(() => expect(storage.getItem(STEWARD_TOKEN_KEY)).toBeNull());
  });
});
