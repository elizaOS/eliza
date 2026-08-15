/** Verifies primeAuthStatusProbe + activation reuse through the package's configured test harness. */
// @vitest-environment jsdom
//
// Startup priming of the /api/auth/me probe (primeAuthStatusProbe): the
// restore phase starts the probe while the backend polling/hydration phases
// run, and the hook's activation reuses that result instead of serializing a
// fresh probe after first paint. Real useAuthStatus + authMe modules under
// test; only global fetch (the network boundary) is stubbed. The shared
// module snapshot is reset per test via the __resetAuthStatusForTests seam.

import {
  clearStoredStewardToken,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStaleStewardSession } from "../cloud/shell/StewardProviderShared";
import { getBootConfig, setBootConfig } from "../config/boot-config-store";
import {
  createPersistedActiveServer,
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "../state/persistence";
import {
  __resetAuthStatusForTests,
  __setAuthStatusForTests,
  isAuthenticatedNow,
  primeAuthStatusProbe,
  subscribeAuthStatus,
  useAuthStatus,
} from "./useAuthStatus";

const AUTH_ME_BODY = {
  identity: { id: "owner", displayName: "Owner", kind: "owner" },
  session: { id: "s1", kind: "browser", expiresAt: null },
  access: { mode: "session", passwordConfigured: true, ownerConfigured: true },
};

function makeJwt(expSecondsFromNow: number): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode({
    exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
  })}.sig`;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("primeAuthStatusProbe + activation reuse", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    delete (window as Window & { __electrobunWindowId?: number })
      .__electrobunWindowId;
    localStorage.clear();
    setBootConfig({ branding: {} });
    __resetAuthStatusForTests();
    setBootConfig({ branding: {} });
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(async () => {
    // React 19 schedules render work as a macrotask (setImmediate /
    // MessageChannel): any work still queued when vitest tears down this
    // file's jsdom environment makes react-dom's performWorkUntilDeadline
    // dereference the deleted `window` and fail the lane as an unhandled
    // exception. Unmount every rendered hook and drain the scheduler while
    // the window is still live, before the network stub is removed.
    cleanup();
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
    globalThis.fetch = realFetch;
    delete (window as Window & { __electrobunWindowId?: number })
      .__electrobunWindowId;
    vi.restoreAllMocks();
    __resetAuthStatusForTests();
  });

  it("fails the shared Cloud auth gate when no Steward account session exists", async () => {
    setBootConfig({
      branding: {},
      apiBase: "https://api.eliza.app/api/v1/eliza/agents/shared-agent",
    });
    clearStoredStewardToken();

    const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));

    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        phase: "unauthenticated",
        reason: "remote_auth_required",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves a native owner API-key session without a Steward JWT", async () => {
    const apiBase = "https://api.eliza.app/api/v1/eliza/agents/shared-agent";
    (
      window as Window & { __electrobunWindowId?: number }
    ).__electrobunWindowId = 1;
    setBootConfig({
      branding: {},
      apiBase,
      apiToken: "eliza_native_owner_key",
    });
    savePersistedActiveServer({
      id: "cloud:shared-agent",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase,
      accessToken: "eliza_native_owner_key",
    });
    clearStoredStewardToken();

    const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));

    await waitFor(() =>
      expect(result.current.state.phase).toBe("authenticated"),
    );
    expect(loadPersistedActiveServer()).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("probes self-hosted targets whose route resembles the shared adapter", async () => {
    setBootConfig({
      branding: {},
      apiBase: "https://vps.example/api/v1/eliza/agents/agent-1",
    });
    fetchMock.mockResolvedValue(jsonResponse(200, AUTH_ME_BODY));

    const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));

    await waitFor(() =>
      expect(result.current.state.phase).toBe("authenticated"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/auth/me");
  });

  it("invalidates a mounted shared Cloud shell immediately when Steward expires", async () => {
    const apiBase = "https://api.eliza.app/api/v1/eliza/agents/shared-agent";
    setBootConfig({ branding: {}, apiBase });
    writeStoredStewardToken(makeJwt(3600));
    savePersistedActiveServer({
      id: "cloud:shared-agent",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase,
      accessToken: "stale-token-mirror",
    });

    const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));
    await waitFor(() =>
      expect(result.current.state.phase).toBe("authenticated"),
    );
    fetchMock.mockResolvedValue(jsonResponse(200, {}));

    act(() => {
      clearStaleStewardSession();
    });

    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        phase: "unauthenticated",
        reason: "remote_auth_required",
      }),
    );
    expect(loadPersistedActiveServer()).toBeNull();
    expect(getBootConfig().apiBase).toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.every(([, init]) => init?.method === "DELETE"),
    ).toBe(true);
  });

  it("invalidates a peer tab when the canonical Steward token is removed", async () => {
    const apiBase = "https://api.eliza.app/api/v1/eliza/agents/shared-agent";
    setBootConfig({ branding: {}, apiBase });
    writeStoredStewardToken(makeJwt(3600));
    savePersistedActiveServer({
      id: "cloud:shared-agent",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase,
    });
    const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));
    await waitFor(() =>
      expect(result.current.state.phase).toBe("authenticated"),
    );

    act(() => {
      localStorage.removeItem("steward_session_token");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "steward_session_token",
          oldValue: makeJwt(3600),
          newValue: null,
        }),
      );
    });

    await waitFor(() =>
      expect(result.current.state.phase).toBe("unauthenticated"),
    );
    expect(loadPersistedActiveServer()).toBeNull();
  });

  it("publishes an authenticated prime and the activating hook reuses it without a second probe", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, AUTH_ME_BODY));

    await act(async () => {
      primeAuthStatusProbe();
    });

    const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));
    await waitFor(() =>
      expect(result.current.state.phase).toBe("authenticated"),
    );
    // Exactly the primed request — activation did not re-probe (and never
    // bounced the shared snapshot back to "loading", which would re-hold the
    // shell on StartupScreen).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/auth/me");
  });

  it("publishes an unauthenticated prime (401 is authoritative) and activation reuses it", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { reason: "remote_auth_required" }),
    );

    await act(async () => {
      primeAuthStatusProbe();
    });

    const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        phase: "unauthenticated",
        reason: "remote_auth_required",
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("removes a rejected remote bearer before retrying the primed auth probe", async () => {
    setBootConfig({
      branding: {},
      apiBase: "https://runtime.example.test",
      apiToken: "stale-token",
    });
    savePersistedActiveServer(
      createPersistedActiveServer({
        kind: "remote",
        apiBase: "https://runtime.example.test",
        accessToken: "stale-token",
      }),
    );
    const unauthorized = {
      reason: "remote_auth_required",
      access: {
        mode: "remote",
        passwordConfigured: true,
        ownerConfigured: false,
      },
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, unauthorized))
      .mockResolvedValueOnce(jsonResponse(401, unauthorized));

    await act(async () => {
      primeAuthStatusProbe();
    });

    const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        phase: "unauthenticated",
        reason: "remote_auth_required",
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const retryHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.get("Authorization")).toBe("Bearer stale-token");
    expect(retryHeaders.has("Authorization")).toBe(false);
    expect(loadPersistedActiveServer()?.accessToken).toBeUndefined();
  });

  it("discards a mid-boot 503 prime and the activation fetch re-probes", async () => {
    // Prime hits the backend while it is still binding…
    fetchMock.mockResolvedValueOnce(jsonResponse(503, {}));
    // …the activation probe (after paintability) finds it up.
    fetchMock.mockResolvedValue(jsonResponse(200, AUTH_ME_BODY));

    await act(async () => {
      primeAuthStatusProbe();
    });

    const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));
    // The prime must NOT have published server_unavailable (that would flash
    // the startup-failure screen for a backend that comes up moments later).
    expect(result.current.state.phase).toBe("loading");
    await waitFor(() =>
      expect(result.current.state.phase).toBe("authenticated"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("overlaps: an activation while the prime is in flight joins it instead of racing a second probe", async () => {
    let resolveProbe: (r: Response) => void = () => {};
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveProbe = resolve;
        }),
    );

    act(() => {
      primeAuthStatusProbe();
    });
    // The probe reaches the network boundary through several async transport
    // hops; wait for the request to actually be in flight before mounting.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));
    expect(result.current.state.phase).toBe("loading");

    await act(async () => {
      resolveProbe(jsonResponse(200, AUTH_ME_BODY));
    });
    await waitFor(() =>
      expect(result.current.state.phase).toBe("authenticated"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetch() still forces a real probe after a primed result", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, AUTH_ME_BODY));

    await act(async () => {
      primeAuthStatusProbe();
    });
    const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));
    await waitFor(() =>
      expect(result.current.state.phase).toBe("authenticated"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.refetch();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("keeps the resolved shell state mounted while a visibility revalidation is in flight", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, AUTH_ME_BODY));

    const { result } = renderHook(() =>
      useAuthStatus({ pollIntervalMs: 60_000 }),
    );
    await waitFor(() =>
      expect(result.current.state.phase).toBe("authenticated"),
    );

    let resolveRevalidation: (response: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveRevalidation = resolve;
        }),
    );
    const observedPhases: string[] = [];
    const unsubscribe = subscribeAuthStatus((state) => {
      observedPhases.push(state.phase);
    });

    try {
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      });

      expect(result.current.state.phase).toBe("authenticated");
      expect(observedPhases).not.toContain("loading");

      await act(async () => {
        resolveRevalidation(
          jsonResponse(401, { reason: "remote_auth_required" }),
        );
      });
      await waitFor(() =>
        expect(result.current.state.phase).toBe("unauthenticated"),
      );
    } finally {
      unsubscribe();
    }
  });

  it("without a prime, activation fetches exactly like before", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, AUTH_ME_BODY));

    const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));
    await waitFor(() =>
      expect(result.current.state.phase).toBe("authenticated"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("isAuthenticatedNow + subscribeAuthStatus (non-hook seam, #16242)", () => {
  beforeEach(() => {
    __resetAuthStatusForTests();
  });
  afterEach(() => {
    __resetAuthStatusForTests();
  });

  it("reads the shared snapshot without a probe and notifies subscribers on publish", () => {
    expect(isAuthenticatedNow()).toBe(false);
    const seen: string[] = [];
    const unsub = subscribeAuthStatus((state) => seen.push(state.phase));

    __setAuthStatusForTests({
      phase: "authenticated",
      identity: { id: "u", displayName: "Owner", kind: "owner" },
      session: { id: "s", kind: "browser", expiresAt: null },
      access: {
        mode: "session",
        passwordConfigured: true,
        ownerConfigured: true,
        role: "OWNER",
      },
    });
    expect(isAuthenticatedNow()).toBe(true);
    expect(seen).toContain("authenticated");

    unsub();
    __setAuthStatusForTests({ phase: "unauthenticated" });
    // After unsubscribe the listener stops receiving updates; the snapshot read
    // still reflects the latest published state.
    expect(isAuthenticatedNow()).toBe(false);
    expect(seen).not.toContain("unauthenticated");
  });
});
