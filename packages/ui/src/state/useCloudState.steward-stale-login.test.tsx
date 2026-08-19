/** Verifies useCloudState — handleCloudLogin with a stale Steward token and no launcher through the package's configured test harness. */
// @vitest-environment jsdom
//
// `useCloudState.handleCloudLogin` sign-in first-click behavior. With a
// stored-but-EXPIRED Steward JWT and NO mounted Steward launcher
// (registerStewardLoginLauncher has no production caller today, so the
// dashboard runs launcher-less), the first click must drain the stale token and
// proceed straight to the device-code flow — not enter the Steward branch,
// which would throw "the Steward login surface is not mounted" and dead-end the
// first click. A still-usable token and a mounted launcher keep the
// Steward-branch behavior. jsdom with the API client mocked.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../api";
import { registerStewardLoginLauncher } from "./cloud-steward-login";
import { useCloudState } from "./useCloudState";

const STEWARD_TOKEN_KEY = "steward_session_token";
const NOT_MOUNTED_ERROR = /Steward login surface is not mounted/;
const DEVICE_CODE_SENTINEL = "device-code-flow-reached";
const globalWithPlatform = globalThis as typeof globalThis & {
  Capacitor?: { isNativePlatform?: () => boolean };
};

/** Build a minimal (unsigned) JWT whose payload carries the given `exp`. */
function makeJwt(expSecondsFromNow: number | null): string {
  const enc = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const header = enc({ alg: "none", typ: "JWT" });
  const payload = enc(
    expSecondsFromNow === null
      ? {}
      : { exp: Math.floor(Date.now() / 1000) + expSecondsFromNow },
  );
  return `${header}.${payload}.sig`;
}

function makeParams() {
  return {
    setActionNotice: vi.fn(),
    loadWalletConfig: vi.fn(async () => {}),
    t: (key: string) => key,
  };
}

describe("useCloudState — handleCloudLogin with a stale Steward token and no launcher", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;
  let cloudLoginSpy: ReturnType<typeof vi.spyOn>;
  let cloudLoginDirectSpy: ReturnType<typeof vi.spyOn>;
  let getCloudStatusSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    // The mount-time token-lifecycle refresh fires on stored-token presence;
    // fail it so the stale token stays in place for the click under test.
    fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, json: async () => ({}) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // Whichever legacy entry point the environment resolves to (agent proxy vs
    // direct cloud auth), report a controlled failure so the login flow stops
    // deterministically without starting the browser-poll interval.
    cloudLoginSpy = vi.spyOn(client, "cloudLogin").mockResolvedValue({
      ok: false,
      sessionId: "",
      browserUrl: "",
      error: DEVICE_CODE_SENTINEL,
    });
    cloudLoginDirectSpy = vi
      .spyOn(client, "cloudLoginDirect")
      .mockResolvedValue({
        ok: false,
        sessionId: "",
        browserUrl: "",
        error: DEVICE_CODE_SENTINEL,
      });
    getCloudStatusSpy = vi.spyOn(client, "getCloudStatus").mockResolvedValue({
      connected: false,
      enabled: false,
    } as Awaited<ReturnType<typeof client.getCloudStatus>>);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    localStorage.clear();
    delete globalWithPlatform.Capacitor;
    vi.restoreAllMocks();
  });

  const deviceCodeCalls = () =>
    cloudLoginSpy.mock.calls.length + cloudLoginDirectSpy.mock.calls.length;

  it("first click falls through to the device-code flow instead of throwing 'not mounted'", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, makeJwt(-60));

    const { result } = renderHook(() => useCloudState(makeParams()));
    await act(async () => {
      await result.current.handleCloudLogin();
    });

    // The FIRST click must reach the legacy device-code flow…
    expect(deviceCodeCalls()).toBe(1);
    // …surface only that flow's outcome (never the launcher-missing throw)…
    expect(result.current.elizaCloudLoginError).toBe(DEVICE_CODE_SENTINEL);
    expect(result.current.elizaCloudLoginError).not.toMatch(NOT_MOUNTED_ERROR);
    // …and drain the stale token so it cannot shadow later authed calls.
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });

  it("does not wedge the login button when already connected but wallet config hydration fails", async () => {
    getCloudStatusSpy.mockResolvedValue({
      connected: true,
      enabled: true,
    } as Awaited<ReturnType<typeof client.getCloudStatus>>);
    vi.spyOn(client, "getCloudCredits").mockResolvedValue({
      balance: 10,
      low: false,
      critical: false,
    } as Awaited<ReturnType<typeof client.getCloudCredits>>);
    const params = makeParams();
    params.loadWalletConfig.mockRejectedValue(new Error("wallet config down"));

    const { result } = renderHook(() => useCloudState(params));
    await act(async () => {
      await result.current.handleCloudLogin();
    });

    expect(deviceCodeCalls()).toBe(0);
    expect(result.current.elizaCloudLoginBusy).toBe(false);
    expect(result.current.elizaCloudLoginError).toBeNull();
    expect(params.setActionNotice).toHaveBeenCalledWith(
      "Already connected to Eliza Cloud.",
      "info",
      4000,
    );
  });

  it("preserves the default cached-server-connected short-circuit", async () => {
    const { result } = renderHook(() => useCloudState(makeParams()));
    act(() => {
      result.current.setElizaCloudConnected(true);
    });
    await waitFor(() => expect(result.current.elizaCloudConnected).toBe(true));

    await act(async () => {
      await result.current.handleCloudLogin();
    });

    expect(deviceCodeCalls()).toBe(0);
  });

  it("requires a client token for onboarding even when cached and fresh server status are connected", async () => {
    getCloudStatusSpy.mockResolvedValue({
      connected: true,
      enabled: true,
    } as Awaited<ReturnType<typeof client.getCloudStatus>>);
    const params = makeParams();
    const { result } = renderHook(() => useCloudState(params));
    act(() => {
      result.current.setElizaCloudConnected(true);
    });
    await waitFor(() => expect(result.current.elizaCloudConnected).toBe(true));

    await act(async () => {
      await result.current.handleCloudLogin(null, {
        requireClientAuth: true,
      });
    });

    expect(deviceCodeCalls()).toBe(1);
    expect(result.current.elizaCloudLoginError).toBe(DEVICE_CODE_SENTINEL);
    expect(params.setActionNotice).not.toHaveBeenCalledWith(
      "Already connected to Eliza Cloud.",
      "info",
      4000,
    );
  });

  it("does not reauthenticate when required client auth is already present", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, makeJwt(3600));
    const { result } = renderHook(() => useCloudState(makeParams()));
    act(() => {
      result.current.setElizaCloudConnected(true);
    });
    await waitFor(() => expect(result.current.elizaCloudConnected).toBe(true));

    await act(async () => {
      await result.current.handleCloudLogin(null, {
        requireClientAuth: true,
      });
    });

    expect(deviceCodeCalls()).toBe(0);
  });

  it("forces native reauthentication after Cloud rejects an opaque device-code token", async () => {
    globalWithPlatform.Capacitor = {
      isNativePlatform: () => true,
    };
    localStorage.setItem(STEWARD_TOKEN_KEY, "revoked-opaque-device-code-token");

    const { result } = renderHook(() => useCloudState(makeParams()));
    act(() => {
      result.current.setElizaCloudConnected(true);
    });
    await waitFor(() => expect(result.current.elizaCloudConnected).toBe(true));

    await act(async () => {
      await result.current.handleCloudLogin(null, {
        requireClientAuth: true,
        forceReauth: true,
      });
    });

    expect(deviceCodeCalls()).toBe(1);
    expect(result.current.elizaCloudLoginError).toBe(DEVICE_CODE_SENTINEL);
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });

  it("a still-usable stored token keeps the Steward short-circuit (no device-code call)", async () => {
    const valid = makeJwt(3600);
    localStorage.setItem(STEWARD_TOKEN_KEY, valid);

    const { result } = renderHook(() => useCloudState(makeParams()));
    await act(async () => {
      await result.current.handleCloudLogin();
    });

    expect(deviceCodeCalls()).toBe(0);
    expect(result.current.elizaCloudLoginError ?? "").not.toMatch(
      NOT_MOUNTED_ERROR,
    );
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(valid);
  });

  it("reauthenticates on the same click when Cloud rejects a reused opaque token", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "revoked-opaque-token");
    getCloudStatusSpy
      .mockImplementationOnce(async () => {
        localStorage.removeItem(STEWARD_TOKEN_KEY);
        return {
          connected: false,
          enabled: false,
          reason: "auth-rejected",
        } as Awaited<ReturnType<typeof client.getCloudStatus>>;
      })
      .mockResolvedValueOnce({
        connected: true,
        enabled: true,
      } as Awaited<ReturnType<typeof client.getCloudStatus>>);
    vi.spyOn(client, "getCloudCredits").mockResolvedValue({
      balance: 10,
      low: false,
      critical: false,
    } as Awaited<ReturnType<typeof client.getCloudCredits>>);
    const launcher = vi.fn(async () => ({ token: makeJwt(3600) }));
    const unregister = registerStewardLoginLauncher(launcher);
    try {
      const { result } = renderHook(() => useCloudState(makeParams()));
      await act(async () => {
        await result.current.handleCloudLogin();
      });

      expect(launcher).toHaveBeenCalledTimes(1);
      expect(getCloudStatusSpy).toHaveBeenCalledTimes(2);
      expect(result.current.elizaCloudConnected).toBe(true);
      expect(result.current.elizaCloudLoginError).toBeNull();
      expect(deviceCodeCalls()).toBe(0);
    } finally {
      unregister();
    }
  });

  it("falls through to device-code on the same click when no Steward launcher is mounted", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "revoked-opaque-token");
    getCloudStatusSpy.mockImplementationOnce(async () => {
      localStorage.removeItem(STEWARD_TOKEN_KEY);
      return {
        connected: false,
        enabled: false,
        reason: "auth-rejected",
      } as Awaited<ReturnType<typeof client.getCloudStatus>>;
    });

    const { result } = renderHook(() => useCloudState(makeParams()));
    await act(async () => {
      await result.current.handleCloudLogin();
    });

    expect(deviceCodeCalls()).toBe(1);
    expect(result.current.elizaCloudLoginError).toBe(DEVICE_CODE_SENTINEL);
    expect(result.current.elizaCloudLoginBusy).toBe(false);
  });

  it("a mounted launcher still owns the stale-token re-auth (no device-code call)", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, makeJwt(-60));
    const launcher = vi.fn(async () => ({ token: makeJwt(3600) }));
    const unregister = registerStewardLoginLauncher(launcher);
    try {
      const { result } = renderHook(() => useCloudState(makeParams()));
      await act(async () => {
        await result.current.handleCloudLogin();
      });

      await waitFor(() => expect(launcher).toHaveBeenCalledTimes(1));
      expect(deviceCodeCalls()).toBe(0);
      expect(result.current.elizaCloudLoginError ?? "").not.toMatch(
        NOT_MOUNTED_ERROR,
      );
    } finally {
      unregister();
    }
  });
});
