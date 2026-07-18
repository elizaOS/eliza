// @vitest-environment jsdom
/**
 * Exercises Cloud login handoff and first-click recovery with a mocked API in
 * jsdom. It covers stale Steward-token fallback plus the single-flight upgrade
 * from server-only authentication to onboarding's renderer-token requirement,
 * including preservation of the user-gesture popup across that handoff.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../api";
import { registerStewardLoginLauncher } from "./cloud-steward-login";
import { useCloudState } from "./useCloudState";

const STEWARD_TOKEN_KEY = "steward_session_token";
const NOT_MOUNTED_ERROR = /Steward login surface is not mounted/;
const DEVICE_CODE_SENTINEL = "device-code-flow-reached";

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
    client.setToken(null);
    client.setBaseUrl(null, { persist: false });
    localStorage.clear();
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

  it("continues onboarding after an in-flight server-only login finishes without a client token", async () => {
    const connectedStatus = {
      connected: true,
      enabled: true,
    } as Awaited<ReturnType<typeof client.getCloudStatus>>;
    let finishServerStatus: (
      response: Awaited<ReturnType<typeof client.getCloudStatus>>,
    ) => void = () => {};
    const serverStatus = new Promise<
      Awaited<ReturnType<typeof client.getCloudStatus>>
    >((resolve) => {
      finishServerStatus = resolve;
    });
    getCloudStatusSpy
      .mockImplementationOnce(() => serverStatus)
      .mockResolvedValue(connectedStatus);
    vi.spyOn(client, "getCloudCredits").mockResolvedValue({
      balance: 10,
      low: false,
      critical: false,
    } as Awaited<ReturnType<typeof client.getCloudCredits>>);

    const { result } = renderHook(() => useCloudState(makeParams()));
    let ordinaryLogin: Promise<void> | undefined;
    act(() => {
      ordinaryLogin = result.current.handleCloudLogin();
    });
    await waitFor(() => expect(getCloudStatusSpy).toHaveBeenCalledTimes(1));

    let onboardingLogin: Promise<void> | undefined;
    act(() => {
      onboardingLogin = result.current.handleCloudLogin(null, {
        requireClientAuth: true,
      });
    });
    finishServerStatus(connectedStatus);

    await act(async () => {
      await Promise.all([ordinaryLogin, onboardingLogin]);
    });

    expect(cloudLoginSpy).toHaveBeenCalledTimes(1);
    expect(result.current.elizaCloudLoginError).toBe(DEVICE_CODE_SENTINEL);
  });

  it("closes a handed-off popup when the weaker flight obtains the required client token", async () => {
    type LoginResponse = Awaited<ReturnType<typeof client.cloudLogin>>;
    let finishOrdinaryLogin: (response: LoginResponse) => void = () => {};
    const ordinaryResponse = new Promise<LoginResponse>((resolve) => {
      finishOrdinaryLogin = resolve;
    });
    cloudLoginSpy.mockImplementationOnce(() => ordinaryResponse);
    const popupState = {
      closed: false,
      close: vi.fn(() => {
        popupState.closed = true;
      }),
      location: { href: "" },
      opener: {},
    };
    const popup = popupState as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);

    const { result } = renderHook(() => useCloudState(makeParams()));
    let ordinaryLogin: Promise<void> | undefined;
    act(() => {
      ordinaryLogin = result.current.handleCloudLogin(popup);
    });
    await waitFor(() => expect(cloudLoginSpy).toHaveBeenCalledOnce());

    let onboardingLogin: Promise<void> | undefined;
    act(() => {
      onboardingLogin = result.current.handleCloudLogin(popup, {
        requireClientAuth: true,
      });
    });
    localStorage.setItem(STEWARD_TOKEN_KEY, makeJwt(3600));
    finishOrdinaryLogin({
      ok: false,
      sessionId: "",
      browserUrl: "",
      error: DEVICE_CODE_SENTINEL,
    });

    await act(async () => {
      await Promise.all([ordinaryLogin, onboardingLogin]);
    });

    expect(cloudLoginSpy).toHaveBeenCalledOnce();
    expect(popupState.close).toHaveBeenCalledOnce();
    expect(result.current.elizaCloudLoginBusy).toBe(false);
  });

  it("single-flights concurrent onboarding upgrades and transfers their user-gesture popup", async () => {
    type LoginResponse = Awaited<ReturnType<typeof client.cloudLogin>>;
    let finishOrdinaryLogin: (response: LoginResponse) => void = () => {};
    let finishOnboardingLogin: (response: LoginResponse) => void = () => {};
    const ordinaryResponse = new Promise<LoginResponse>((resolve) => {
      finishOrdinaryLogin = resolve;
    });
    const onboardingResponse = new Promise<LoginResponse>((resolve) => {
      finishOnboardingLogin = resolve;
    });
    cloudLoginSpy
      .mockImplementationOnce(() => ordinaryResponse)
      .mockImplementationOnce(() => onboardingResponse);

    const ordinaryPopupState = {
      closed: false,
      close: vi.fn(() => {
        ordinaryPopupState.closed = true;
      }),
      location: { href: "" },
      opener: {},
    };
    const onboardingPopupState = {
      closed: false,
      close: vi.fn(() => {
        onboardingPopupState.closed = true;
      }),
      location: { href: "" },
      opener: {},
    };
    const ordinaryPopup = ordinaryPopupState as unknown as Window;
    const onboardingPopup = onboardingPopupState as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(onboardingPopup);

    const { result } = renderHook(() => useCloudState(makeParams()));
    let ordinaryLogin: Promise<void> | undefined;
    act(() => {
      ordinaryLogin = result.current.handleCloudLogin(ordinaryPopup);
    });
    await waitFor(() => expect(cloudLoginSpy).toHaveBeenCalledTimes(1));

    let firstOnboardingLogin: Promise<void> | undefined;
    let secondOnboardingLogin: Promise<void> | undefined;
    act(() => {
      firstOnboardingLogin = result.current.handleCloudLogin(onboardingPopup, {
        requireClientAuth: true,
      });
      secondOnboardingLogin = result.current.handleCloudLogin(null, {
        requireClientAuth: true,
      });
    });
    finishOrdinaryLogin({
      ok: false,
      sessionId: "",
      browserUrl: "",
      error: DEVICE_CODE_SENTINEL,
    });

    await waitFor(() => expect(cloudLoginSpy).toHaveBeenCalledTimes(2));
    expect(ordinaryPopupState.closed).toBe(true);
    expect(ordinaryPopupState.close).toHaveBeenCalledOnce();
    expect(onboardingPopupState.closed).toBe(false);
    expect(result.current.elizaCloudLoginBusy).toBe(true);

    finishOnboardingLogin({
      ok: false,
      sessionId: "",
      browserUrl: "",
      error: DEVICE_CODE_SENTINEL,
    });
    await act(async () => {
      await Promise.all([
        ordinaryLogin,
        firstOnboardingLogin,
        secondOnboardingLogin,
      ]);
    });

    expect(cloudLoginSpy).toHaveBeenCalledTimes(2);
    expect(onboardingPopupState.close).toHaveBeenCalledTimes(1);
    expect(result.current.elizaCloudLoginBusy).toBe(false);
  });

  it("hands off popup ownership when a weaker device-code poll expires", async () => {
    vi.useFakeTimers();
    type LoginResponse = Awaited<ReturnType<typeof client.cloudLogin>>;
    let finishOnboardingLogin: (response: LoginResponse) => void = () => {};
    const onboardingResponse = new Promise<LoginResponse>((resolve) => {
      finishOnboardingLogin = resolve;
    });
    cloudLoginSpy
      .mockResolvedValueOnce({
        ok: true,
        sessionId: "session-expired",
        browserUrl: "https://elizacloud.ai/login/session-expired",
      })
      .mockImplementationOnce(() => onboardingResponse);
    vi.spyOn(client, "cloudLoginPoll").mockResolvedValue({
      status: "expired",
      error: "Login session expired",
    });
    const ordinaryPopupState = {
      closed: false,
      close: vi.fn(() => {
        ordinaryPopupState.closed = true;
      }),
      location: { href: "" },
      opener: {},
    };
    const onboardingPopupState = {
      closed: false,
      close: vi.fn(() => {
        onboardingPopupState.closed = true;
      }),
      location: { href: "" },
      opener: {},
    };
    const ordinaryPopup = ordinaryPopupState as unknown as Window;
    const onboardingPopup = onboardingPopupState as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(onboardingPopup);

    try {
      const { result } = renderHook(() => useCloudState(makeParams()));
      let ordinaryLogin: Promise<void> | undefined;
      await act(async () => {
        ordinaryLogin = result.current.handleCloudLogin(ordinaryPopup);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(cloudLoginSpy).toHaveBeenCalledOnce();

      let onboardingLogin: Promise<void> | undefined;
      act(() => {
        onboardingLogin = result.current.handleCloudLogin(onboardingPopup, {
          requireClientAuth: true,
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(cloudLoginSpy).toHaveBeenCalledTimes(2);
      expect(ordinaryPopupState.close).toHaveBeenCalledOnce();
      expect(onboardingPopupState.closed).toBe(false);

      finishOnboardingLogin({
        ok: false,
        sessionId: "",
        browserUrl: "",
        error: DEVICE_CODE_SENTINEL,
      });
      await act(async () => {
        await Promise.all([ordinaryLogin, onboardingLogin]);
      });

      expect(onboardingPopupState.close).toHaveBeenCalledOnce();
      expect(result.current.elizaCloudLoginBusy).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not treat a local agent REST bearer as onboarding Cloud auth", async () => {
    client.setBaseUrl("http://127.0.0.1:2508", { persist: false });
    client.setToken("local-agent-token");
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

  it("reauthenticates onboarding when the cached server is connected but the Steward JWT is expired", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, makeJwt(-60));
    getCloudStatusSpy.mockResolvedValue({
      connected: true,
      enabled: true,
    } as Awaited<ReturnType<typeof client.getCloudStatus>>);
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

    expect(deviceCodeCalls()).toBe(1);
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    expect(result.current.elizaCloudLoginError).toBe(DEVICE_CODE_SENTINEL);
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
