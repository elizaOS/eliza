/** Verifies useAdminGate session resolution (no Steward provider mounted — the page-reload reality) through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * `useAdminGate` session resolution. The Steward SDK context keeps its session
 * in MemoryStorage — empty on every full page load — so the gate must resolve
 * from the persisted localStorage JWT like the rest of the console, or a fully
 * signed-in user is locked out with "Sign in required" after a reload. These
 * tests exercise the gate with ONLY the persisted token present (no Steward
 * provider mounted), which is the reload reality.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// --- Gate resolution beyond session presence --------------------------------
// The dev bypass and the production HEAD probe are driven through the REAL
// hook, real react-query, and the real persisted-JWT auth path above; only
// the HTTP transport (`apiFetch`) is faked, because jsdom has no Eliza Cloud
// backend to answer the moderation probe. Vitest itself runs with
// `import.meta.env.DEV === true`, so the bypass branch is the harness default
// and the production branch is reached by flipping DEV off per test.

vi.mock("../../lib/api-client", () => ({ apiFetch: vi.fn() }));

const ORIGINAL_DEV = import.meta.env.DEV;

async function apiFetchMock() {
  const mod = await import("../../lib/api-client");
  return vi.mocked(mod.apiFetch);
}

// vitest.config.ts sets `globals: false`, so @testing-library/react cannot
// self-register auto-cleanup; without this every hook stays mounted and
// earlier observers leak into later assertions.
async function cleanupMounted() {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
}

function headProbeResponse(headers: Record<string, string>): Response {
  return new Response(null, { status: 200, headers });
}

describe("useAdminGate dev bypass (the vitest harness runs a dev build)", () => {
  afterEach(cleanupMounted);

  it("grants a signed-in local user super_admin without touching the network", async () => {
    storage.setItem(
      "steward_session_token",
      makeJwt({ userId: "u1", exp: Math.floor(Date.now() / 1000) + 600 }),
    );

    const { result } = renderHook(() => useAdminGate(), { wrapper });

    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    expect(result.current.isAdmin).toBe(true);
    expect(result.current.role).toBe("super_admin");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isError).toBe(false);

    const mock = await apiFetchMock();
    expect(mock).not.toHaveBeenCalled();
  });

  it("keeps a signed-out dev visitor out with no role", async () => {
    const { result } = renderHook(() => useAdminGate(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.role).toBe(null);
  });
});

describe("useAdminGate production HEAD-probe gate (dev bypass disabled)", () => {
  beforeEach(() => {
    import.meta.env.DEV = false;
  });

  afterEach(async () => {
    import.meta.env.DEV = ORIGINAL_DEV;
    (await apiFetchMock()).mockReset();
    await cleanupMounted();
  });

  it("admits an admin from the moderation probe's X-Is-Admin/X-Admin-Role headers", async () => {
    storage.setItem(
      "steward_session_token",
      makeJwt({ userId: "u1", exp: Math.floor(Date.now() / 1000) + 600 }),
    );
    const mock = await apiFetchMock();
    mock.mockResolvedValueOnce(
      headProbeResponse({
        "x-is-admin": "true",
        "x-admin-role": "moderator",
      }),
    );

    const { result } = renderHook(() => useAdminGate(), { wrapper });

    await waitFor(() =>
      expect(result.current).toMatchObject({
        isAdmin: true,
        role: "moderator",
        isLoading: false,
        isError: false,
        isAuthenticated: true,
      }),
    );
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith("/api/v1/admin/moderation", {
      method: "HEAD",
    });
  });

  it("drops an unrecognized role header to null but keeps the admin admitted", async () => {
    storage.setItem(
      "steward_session_token",
      makeJwt({ userId: "u1", exp: Math.floor(Date.now() / 1000) + 600 }),
    );
    const mock = await apiFetchMock();
    mock.mockResolvedValueOnce(
      headProbeResponse({ "x-is-admin": "true", "x-admin-role": "owner" }),
    );

    const { result } = renderHook(() => useAdminGate(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAdmin).toBe(true);
    expect(result.current.role).toBe(null);
    expect(result.current.isError).toBe(false);
  });

  it("keys admission on X-Is-Admin alone — a valid role header cannot grant access by itself", async () => {
    storage.setItem(
      "steward_session_token",
      makeJwt({ userId: "u1", exp: Math.floor(Date.now() / 1000) + 600 }),
    );
    const mock = await apiFetchMock();
    mock.mockResolvedValueOnce(
      headProbeResponse({
        "x-is-admin": "false",
        "x-admin-role": "super_admin",
      }),
    );

    const { result } = renderHook(() => useAdminGate(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.role).toBe("super_admin");
  });

  it("reports an error and denies access when the HEAD probe fails", async () => {
    storage.setItem(
      "steward_session_token",
      makeJwt({ userId: "u1", exp: Math.floor(Date.now() / 1000) + 600 }),
    );
    const mock = await apiFetchMock();
    mock.mockRejectedValueOnce(new Error("probe failed"));

    const { result } = renderHook(() => useAdminGate(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.role).toBe(null);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isAuthenticated).toBe(true);
  });

  it("never issues the HEAD probe for a signed-out visitor", async () => {
    const { result } = renderHook(() => useAdminGate(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const mock = await apiFetchMock();
    expect(mock).not.toHaveBeenCalled();
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.role).toBe(null);
  });

  it("holds isLoading with deny-by-default fields while the probe is in flight", async () => {
    storage.setItem(
      "steward_session_token",
      makeJwt({ userId: "u1", exp: Math.floor(Date.now() / 1000) + 600 }),
    );
    const mock = await apiFetchMock();
    mock.mockReturnValueOnce(new Promise<Response>(() => {}));

    const { result } = renderHook(() => useAdminGate(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(true));
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.role).toBe(null);
    expect(result.current.isError).toBe(false);
    expect(result.current.isAuthenticated).toBe(true);
  });

  it("serves a remount within staleTime from the cache instead of re-probing", async () => {
    storage.setItem(
      "steward_session_token",
      makeJwt({ userId: "u1", exp: Math.floor(Date.now() / 1000) + 600 }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const clientWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const mock = await apiFetchMock();
    mock.mockResolvedValueOnce(
      headProbeResponse({ "x-is-admin": "true", "x-admin-role": "viewer" }),
    );
    const callsAtStart = mock.mock.calls.length;

    const first = renderHook(() => useAdminGate(), {
      wrapper: clientWrapper,
    });
    await waitFor(() => expect(first.result.current.isAdmin).toBe(true));
    expect(first.result.current.role).toBe("viewer");
    expect(mock.mock.calls.length - callsAtStart).toBe(1);
    first.unmount();

    const second = renderHook(() => useAdminGate(), {
      wrapper: clientWrapper,
    });
    await waitFor(() =>
      expect(second.result.current.isAuthenticated).toBe(true),
    );
    expect(second.result.current.isAdmin).toBe(true);
    expect(second.result.current.role).toBe("viewer");
    // staleTime is 5 minutes — the remount must be served by the cache, not
    // by a second HEAD probe.
    expect(mock.mock.calls.length - callsAtStart).toBe(1);
    second.unmount();
  });
});
