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
import { authMe } from "../api/auth-client";
import { client } from "../api/client";
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
  revalidateAuthStatus,
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

function jsonResponse(
  status: number,
  body: unknown,
  headers?: HeadersInit,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  } as unknown as Response;
}

function setStewardAuthedCookie(present: boolean): void {
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API.
  document.cookie = present
    ? "steward-authed=1; Path=/"
    : "steward-authed=; Max-Age=0; Path=/";
}

describe("primeAuthStatusProbe + activation reuse", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    delete (window as Window & { __electrobunWindowId?: number })
      .__electrobunWindowId;
    localStorage.clear();
    setStewardAuthedCookie(false);
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
    setStewardAuthedCookie(false);
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
    await clearStoredStewardToken();

    const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));

    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        phase: "unauthenticated",
        reason: "remote_auth_required",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recovers a cookie-only Steward session before preserving the shared binding", async () => {
    const apiBase = "https://api.eliza.app/api/v1/eliza/agents/shared-agent";
    const refreshedToken = makeJwt(3600);
    setBootConfig({ branding: {}, apiBase });
    savePersistedActiveServer({
      id: "cloud:shared-agent",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase,
      accessToken: "shared-agent-token",
    });
    await clearStoredStewardToken();
    setStewardAuthedCookie(true);
    fetchMock.mockResolvedValue(jsonResponse(200, { token: refreshedToken }));

    const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));

    await waitFor(() =>
      expect(result.current.state.phase).toBe("authenticated"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/api/auth/steward-refresh",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "include",
    });
    expect(localStorage.getItem("steward_session_token")).toBe(refreshedToken);
    expect(loadPersistedActiveServer()).toMatchObject({
      id: "cloud:shared-agent",
      apiBase,
      accessToken: "shared-agent-token",
    });
    expect(getBootConfig().apiBase).toBe(apiBase);
  });

  it("clears a cookie-only shared binding once after authoritative refresh rejection", async () => {
    const apiBase = "https://api.eliza.app/api/v1/eliza/agents/shared-agent";
    setBootConfig({ branding: {}, apiBase });
    savePersistedActiveServer({
      id: "cloud:shared-agent",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase,
      accessToken: "stale-token-mirror",
    });
    await clearStoredStewardToken();
    setStewardAuthedCookie(true);
    fetchMock.mockResolvedValue(jsonResponse(401, {}));

    const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));

    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        phase: "unauthenticated",
        reason: "remote_auth_required",
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loadPersistedActiveServer()).toBeNull();
    expect(getBootConfig().apiBase).toBeUndefined();
  });

  it("preserves a cookie-only shared binding when refresh is temporarily unavailable", async () => {
    const apiBase = "https://api.eliza.app/api/v1/eliza/agents/shared-agent";
    setBootConfig({ branding: {}, apiBase });
    savePersistedActiveServer({
      id: "cloud:shared-agent",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase,
      accessToken: "shared-agent-token",
    });
    await clearStoredStewardToken();
    setStewardAuthedCookie(true);
    fetchMock.mockResolvedValue(jsonResponse(503, {}));

    await expect(authMe()).resolves.toEqual({
      ok: false,
      status: 503,
      reason: "cloud_unavailable",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loadPersistedActiveServer()).toMatchObject({
      id: "cloud:shared-agent",
      apiBase,
      accessToken: "shared-agent-token",
    });
    expect(getBootConfig().apiBase).toBe(apiBase);
  });

  // Regression for the review-found retry storm: the hook's 10×1s 503 retry
  // budget exists for the local-agent boot race, and must not re-POST a
  // throttling Steward refresh endpoint. Exactly one refresh request may
  // leave the client before the hook settles on server_unavailable.
  it.each([429, 503])(
    "surfaces a persistent %d refresh as server_unavailable after exactly one POST",
    async (status) => {
      const apiBase = "https://api.eliza.app/api/v1/eliza/agents/shared-agent";
      setBootConfig({ branding: {}, apiBase });
      savePersistedActiveServer({
        id: "cloud:shared-agent",
        kind: "cloud",
        label: "Eliza Cloud",
        apiBase,
        accessToken: "shared-agent-token",
      });
      await clearStoredStewardToken();
      setStewardAuthedCookie(true);
      fetchMock.mockResolvedValue(jsonResponse(status, {}));

      const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));

      await waitFor(() =>
        expect(result.current.state.phase).toBe("server_unavailable"),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(loadPersistedActiveServer()).toMatchObject({
        id: "cloud:shared-agent",
        apiBase,
        accessToken: "shared-agent-token",
      });
    },
  );

  it("preserves a cookie-only shared binding when refresh answers a malformed 200", async () => {
    const apiBase = "https://api.eliza.app/api/v1/eliza/agents/shared-agent";
    setBootConfig({ branding: {}, apiBase });
    savePersistedActiveServer({
      id: "cloud:shared-agent",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase,
      accessToken: "shared-agent-token",
    });
    await clearStoredStewardToken();
    setStewardAuthedCookie(true);
    fetchMock.mockResolvedValue(jsonResponse(200, {}));

    await expect(authMe()).resolves.toEqual({
      ok: false,
      status: 503,
      reason: "cloud_unavailable",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loadPersistedActiveServer()).toMatchObject({
      id: "cloud:shared-agent",
      apiBase,
      accessToken: "shared-agent-token",
    });
    expect(getBootConfig().apiBase).toBe(apiBase);
  });

  it("preserves a native owner API-key session without a Steward JWT", async () => {
    const apiBase = "https://api.eliza.app/api/v1/eliza/agents/shared-agent";
    await clearStoredStewardToken();
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
    await writeStoredStewardToken(makeJwt(3600));
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

    await act(async () => {
      await clearStaleStewardSession();
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
    await writeStoredStewardToken(makeJwt(3600));
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
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/auth/me")) return jsonResponse(401, unauthorized);
      if (url.endsWith("/api/auth/status"))
        return jsonResponse(200, { required: true, pairingEnabled: false });
      throw new Error("Unexpected fixture request");
    });

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
    const probes = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/auth/me"),
    );
    expect(probes).toHaveLength(2);
    const firstHeaders = new Headers(probes[0]?.[1]?.headers);
    const retryHeaders = new Headers(probes[1]?.[1]?.headers);
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

  it("waits through a throttled prime without starting the 503 retry storm", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, {}, { "Retry-After": "0" }))
      .mockResolvedValueOnce(jsonResponse(200, AUTH_ME_BODY));

    await act(async () => {
      primeAuthStatusProbe();
    });

    const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));
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

  it("discards a late success without detaching the replacement probe", async () => {
    client.setBaseUrl("https://first.example.test");
    const first = Promise.withResolvers<Response>();
    const second = Promise.withResolvers<Response>();
    fetchMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    act(() => client.setBaseUrl("https://second.example.test"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => first.resolve(jsonResponse(200, AUTH_ME_BODY)));
    expect(result.current.state.phase).toBe("loading");
    const joined = revalidateAuthStatus();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      second.resolve(
        jsonResponse(401, {
          reason: "remote_password_not_configured",
          access: {
            mode: "remote",
            passwordConfigured: false,
            ownerConfigured: true,
          },
        }),
      );
      await joined;
    });
    expect(result.current.state.phase).toBe("unauthenticated");
  });

  it("does not reuse a fresh startup prime from the previous server", async () => {
    client.setBaseUrl("https://first.example.test");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, AUTH_ME_BODY));
    primeAuthStatusProbe();
    await waitFor(() => expect(isAuthenticatedNow()).toBe(true));
    client.setBaseUrl("https://second.example.test");
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        ...AUTH_ME_BODY,
        identity: { ...AUTH_ME_BODY.identity, id: "second-owner" },
      }),
    );
    const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        phase: "authenticated",
        identity: { id: "second-owner" },
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not continue an old rejection through the replacement server's pairing route", async () => {
    client.setBaseUrl("https://first.example.test");
    const first = Promise.withResolvers<Response>();
    fetchMock
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(jsonResponse(200, { required: false }));
    const pending = authMe();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    client.setBaseUrl("https://second.example.test");
    client.setToken("second-token");
    first.resolve(
      jsonResponse(401, {
        reason: "remote_auth_required",
        access: {
          mode: "remote",
          passwordConfigured: true,
          ownerConfigured: true,
        },
      }),
    );
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getBootConfig().apiToken).toBe("second-token");
  });

  it("does not return the old identity when selection changes during body parsing", async () => {
    client.setBaseUrl("https://first.example.test");
    const body = Promise.withResolvers<typeof AUTH_ME_BODY>();
    const response = jsonResponse(200, AUTH_ME_BODY);
    const parse = vi.fn(() => body.promise);
    response.json = parse;
    fetchMock.mockResolvedValueOnce(response);
    const pending = authMe();
    await waitFor(() => expect(parse).toHaveBeenCalledOnce());
    client.setBaseUrl("https://second.example.test");
    body.resolve(AUTH_ME_BODY);
    expect(await pending).toMatchObject({ ok: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not clear a replacement Cloud binding after a stale refresh rejection", async () => {
    const firstBase = "https://api.eliza.app/api/v1/eliza/agents/shared-first";
    const secondBase =
      "https://api.eliza.app/api/v1/eliza/agents/shared-second";
    client.setBaseUrl(firstBase);
    client.setToken(null);
    await writeStoredStewardToken(makeJwt(-3600));
    savePersistedActiveServer({
      id: "cloud:first",
      kind: "cloud",
      label: "First",
      apiBase: firstBase,
      accessToken: "first-agent-token",
    });
    const refresh = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(refresh.promise);
    const pending = authMe();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    client.setBaseUrl(secondBase);
    savePersistedActiveServer({
      id: "cloud:second",
      kind: "cloud",
      label: "Second",
      apiBase: secondBase,
      accessToken: "second-agent-token",
    });
    refresh.resolve(jsonResponse(401, {}));
    await pending;
    expect(loadPersistedActiveServer()).toMatchObject({
      id: "cloud:second",
      apiBase: secondBase,
    });
    expect(getBootConfig().apiBase).toBe(secondBase);
  });

  it("revalidates a mounted gate against the newly selected server", async () => {
    client.setBaseUrl("https://first.example.test");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, AUTH_ME_BODY));
    const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));
    await waitFor(() =>
      expect(result.current.state.phase).toBe("authenticated"),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, {
        reason: "remote_password_not_configured",
        access: {
          mode: "remote",
          passwordConfigured: true,
          ownerConfigured: true,
        },
      }),
    );
    act(() => client.setBaseUrl("https://second.example.test"));
    expect(result.current.state.phase).toBe("loading");
    await waitFor(() =>
      expect(result.current.state.phase).toBe("unauthenticated"),
    );
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe(
      "https://second.example.test/api/auth/me",
    );
  });

  it("does not let the previous server's delayed rejection erase the new credential", async () => {
    client.setBaseUrl("https://first.example.test");
    client.setToken("first-token");
    let rejectFirst!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          rejectFirst = resolve;
        }),
    );
    const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ...AUTH_ME_BODY,
        identity: { ...AUTH_ME_BODY.identity, id: "second-owner" },
      }),
    );
    act(() => {
      client.setBaseUrl("https://second.example.test");
      client.setToken("second-token");
    });
    await act(async () =>
      rejectFirst(
        jsonResponse(401, {
          reason: "remote_password_not_configured",
          access: {
            mode: "remote",
            passwordConfigured: true,
            ownerConfigured: true,
          },
        }),
      ),
    );
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        phase: "authenticated",
        identity: { id: "second-owner" },
      }),
    );
    expect(getBootConfig().apiToken).toBe("second-token");
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).startsWith("https://first.example.test"),
      ),
    ).toHaveLength(1);
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
