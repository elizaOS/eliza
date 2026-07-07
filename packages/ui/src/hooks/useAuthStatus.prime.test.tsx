// @vitest-environment jsdom
//
// Startup priming of the /api/auth/me probe (primeAuthStatusProbe): the
// restore phase starts the probe while the backend polling/hydration phases
// run, and the hook's activation reuses that result instead of serializing a
// fresh probe after first paint. Real useAuthStatus + authMe modules under
// test; only global fetch (the network boundary) is stubbed. The shared
// module snapshot is reset per test via the __resetAuthStatusForTests seam.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetAuthStatusForTests,
  primeAuthStatusProbe,
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

describe("primeAuthStatusProbe + activation reuse", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    __resetAuthStatusForTests();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
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
});
