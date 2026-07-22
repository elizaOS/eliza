// @vitest-environment jsdom
//
// Startup priming of the /api/auth/me probe (primeAuthStatusProbe): the
// restore phase starts the probe while the backend polling/hydration phases
// run, and the hook's activation reuses that result instead of serializing a
// fresh probe after first paint. Real useAuthStatus + authMe modules under
// test; only global fetch (the network boundary) is stubbed. The shared
// module snapshot is reset per test via the __resetAuthStatusForTests seam.

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetAuthStatusForTests,
  __setAuthStatusForTests,
  isAuthenticatedNow,
  primeAuthStatusProbe,
  refreshAuthStatus,
  subscribeAuthStatus,
  useAuthStatus,
} from "./useAuthStatus";

const AUTH_ME_BODY = {
  identity: { id: "owner", displayName: "Owner", kind: "owner" },
  session: { id: "s1", kind: "browser", expiresAt: null },
  access: { mode: "session", passwordConfigured: true, ownerConfigured: true },
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function malformedJsonResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Malformed auth JSON");
    },
  } as unknown as Response;
}

describe("primeAuthStatusProbe + activation reuse", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    __resetAuthStatusForTests();
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
    vi.restoreAllMocks();
    __resetAuthStatusForTests();
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

  it("without a prime, activation fetches exactly like before", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, AUTH_ME_BODY));

    const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));
    await waitFor(() =>
      expect(result.current.state.phase).toBe("authenticated"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("translates a malformed successful refresh into the explicit unavailable state", async () => {
    fetchMock.mockResolvedValue(malformedJsonResponse());
    const { result } = renderHook(() =>
      useAuthStatus({ pollIntervalMs: 0, observeOnly: true }),
    );

    await act(async () => {
      await refreshAuthStatus();
    });

    expect(result.current.state.phase).toBe("server_unavailable");
  });

  it("suppresses a delayed pre-login 401 and coalesces one required post-login probe", async () => {
    let resolvePreLogin: (response: Response) => void = () => {};
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolvePreLogin = resolve;
          }),
      )
      .mockResolvedValueOnce(jsonResponse(200, AUTH_ME_BODY));

    const seen: string[] = [];
    const unsubscribe = subscribeAuthStatus((state) => seen.push(state.phase));
    const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));
    await vi.waitFor(() => expect(fetchMock.mock.calls).toHaveLength(1));

    let firstRefresh!: Promise<void>;
    let duplicateRefresh!: Promise<void>;
    act(() => {
      firstRefresh = refreshAuthStatus();
      duplicateRefresh = refreshAuthStatus();
    });
    expect(duplicateRefresh).toBe(firstRefresh);

    await act(async () => {
      resolvePreLogin(jsonResponse(401, { reason: "remote_auth_required" }));
      await firstRefresh;
    });

    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(seen).not.toContain("unauthenticated");
    expect(result.current.state.phase).toBe("authenticated");
    unsubscribe();
  });

  it("contains a malformed primed response as an explicit unavailable state", async () => {
    fetchMock.mockResolvedValue(malformedJsonResponse());
    const { result } = renderHook(() =>
      useAuthStatus({ pollIntervalMs: 0, observeOnly: true }),
    );

    act(() => {
      primeAuthStatusProbe();
    });

    await waitFor(() =>
      expect(result.current.state.phase).toBe("server_unavailable"),
    );
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
