// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://app.elizacloud.ai/" }
//
// `useCloudState.handleCloudLogin` popup→same-tab fallback (#15143). On hosted
// web (direct cloud auth, no agent proxy) a dead popup handle — null from a
// blocked pre-open, on any browser — must navigate THIS tab to the same-origin
// /login page with a returnTo instead of starting a device-code session whose
// popup would never open, and must leave the first-run cloud-resume marker
// intact for the round trip. A live popup handle keeps the device-code popup
// flow. jsdom pinned to a hosted elizacloud origin with the API client mocked.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../api";
import {
  markCloudLoginPending,
  readCloudLoginPending,
} from "../first-run/first-run-cloud-resume";
import { CLOUD_LOGIN_POPUP_NAME } from "./cloud-login-launch";
import { registerStewardLoginLauncher } from "./cloud-steward-login";
import { useCloudState } from "./useCloudState";

const DEVICE_CODE_SENTINEL = "device-code-flow-reached";
const originalLocationDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "location",
);
const globalWithPlatform = globalThis as typeof globalThis & {
  Capacitor?: { isNativePlatform?: () => boolean };
};

function makeParams() {
  return {
    setActionNotice: vi.fn(),
    loadWalletConfig: vi.fn(async () => {}),
    t: (key: string) => key,
  };
}

describe("useCloudState — handleCloudLogin same-tab fallback on hosted web", () => {
  let assignSpy: ReturnType<typeof vi.fn>;
  let cloudLoginSpy: ReturnType<typeof vi.spyOn>;
  let cloudLoginDirectSpy: ReturnType<typeof vi.spyOn>;
  let cloudLoginPollDirectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    assignSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign: assignSpy },
    });
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
    cloudLoginPollDirectSpy = vi
      .spyOn(client, "cloudLoginPollDirect")
      .mockResolvedValue({ status: "pending" });
    vi.spyOn(client, "setBaseUrl").mockImplementation(() => undefined);
    vi.spyOn(client, "setToken").mockImplementation(() => undefined);
  });

  afterEach(() => {
    localStorage.clear();
    delete globalWithPlatform.Capacitor;
    vi.restoreAllMocks();
    if (originalLocationDescriptor) {
      Object.defineProperty(window, "location", originalLocationDescriptor);
    }
  });

  const deviceCodeCalls = () =>
    cloudLoginSpy.mock.calls.length + cloudLoginDirectSpy.mock.calls.length;

  it("a dead popup handle navigates same-tab to /login with returnTo and starts no device-code session", async () => {
    const { result } = renderHook(() => useCloudState(makeParams()));
    await act(async () => {
      await result.current.handleCloudLogin(null);
    });

    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith("/login?returnTo=%2F");
    expect(deviceCodeCalls()).toBe(0);
    expect(result.current.elizaCloudLoginBusy).toBe(false);
    expect(result.current.elizaCloudLoginError).toBeNull();
  });

  it("leaves the first-run cloud-resume marker intact across the redirect leg", async () => {
    markCloudLoginPending({
      runtime: "cloud",
      localInference: "cloud-inference",
      agentName: "Eliza",
    });

    const { result } = renderHook(() => useCloudState(makeParams()));
    await act(async () => {
      await result.current.handleCloudLogin(null);
    });

    expect(assignSpy).toHaveBeenCalledWith("/login?returnTo=%2F");
    expect(readCloudLoginPending()).toEqual({
      runtime: "cloud",
      localInference: "cloud-inference",
      agentName: "Eliza",
    });
  });

  it("a live popup handle keeps the device-code popup flow (no same-tab navigation)", async () => {
    const popup = {
      closed: false,
      close: vi.fn(),
      location: { href: "" },
      opener: {},
    } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);

    const { result } = renderHook(() => useCloudState(makeParams()));
    await act(async () => {
      await result.current.handleCloudLogin(popup);
    });

    expect(assignSpy).not.toHaveBeenCalled();
    expect(cloudLoginDirectSpy).toHaveBeenCalledTimes(1);
    expect(result.current.elizaCloudLoginError).toBe(DEVICE_CODE_SENTINEL);
  });

  it("closes a pre-opened popup when direct cloud login startup throws", async () => {
    const popup = {
      closed: false,
      close: vi.fn(() => {
        (popup as { closed: boolean }).closed = true;
      }),
      location: { href: "" },
      opener: {},
    } as unknown as Window;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popup);
    cloudLoginDirectSpy.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useCloudState(makeParams()));
    await act(async () => {
      await result.current.handleCloudLogin(popup);
    });

    expect(cloudLoginDirectSpy).toHaveBeenCalledTimes(1);
    expect(popup.close).toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith("", CLOUD_LOGIN_POPUP_NAME);
    expect(result.current.elizaCloudLoginError).toBe("network down");
    expect(result.current.elizaCloudLoginBusy).toBe(false);
  });

  it("resumes a direct cloud login when the auth tab returns with a CLI session", async () => {
    const search =
      "?elizaCloudLogin=complete&elizaCloudLoginSession=sess-return";
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        href: `https://app.elizacloud.ai/chat${search}`,
        pathname: "/chat",
        search,
        assign: assignSpy,
      },
    });
    cloudLoginPollDirectSpy.mockResolvedValue({
      status: "authenticated",
      organizationId: "org-1",
      token: "session-token",
      userId: "user-1",
    });
    const params = makeParams();

    const { result } = renderHook(() => useCloudState(params));

    await waitFor(() => {
      expect(localStorage.getItem("steward_session_token")).toBe(
        "session-token",
      );
      expect(result.current.elizaCloudConnected).toBe(true);
    });
    expect(cloudLoginPollDirectSpy).toHaveBeenCalledWith(
      "https://api.elizacloud.ai",
      "sess-return",
    );
    expect(params.setActionNotice).not.toHaveBeenCalled();
  });

  it("preserves the cloud auth popup opener and closes it on the matching completion message", async () => {
    vi.useFakeTimers();
    const opener = { source: "app" };
    const popup = {
      closed: false,
      close: vi.fn(),
      location: { href: "" },
      opener,
    } as unknown as Window;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popup);
    cloudLoginDirectSpy.mockResolvedValue({
      ok: true,
      apiBase: "https://api.elizacloud.ai/api/v1",
      browserUrl: "https://elizacloud.ai/auth/cli-login?session=sess-1",
      sessionId: "sess-1",
    });

    try {
      const { result, unmount } = renderHook(() => useCloudState(makeParams()));
      await act(async () => {
        void result.current.handleCloudLogin(popup);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(cloudLoginDirectSpy).toHaveBeenCalledTimes(1);
      expect(popup.location.href).toBe(
        "https://elizacloud.ai/auth/cli-login?session=sess-1",
      );
      expect((popup as unknown as { opener: unknown }).opener).toBe(opener);

      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: "https://elizacloud.ai",
            data: {
              type: "eliza-cloud-auth-complete",
              sessionId: "wrong-session",
            },
          }),
        );
      });
      expect(popup.close).not.toHaveBeenCalled();

      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: "https://elizacloud.ai",
            data: {
              type: "eliza-cloud-auth-complete",
              sessionId: "sess-1",
            },
          }),
        );
      });
      expect(popup.close).toHaveBeenCalledTimes(1);
      expect(openSpy).toHaveBeenCalledWith("", CLOUD_LOGIN_POPUP_NAME);

      unmount();
      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the named popup when direct cloud polling authenticates", async () => {
    vi.useFakeTimers();
    const popup = {
      closed: false,
      close: vi.fn(() => {
        (popup as { closed: boolean }).closed = true;
      }),
      location: { href: "" },
      opener: {},
    } as unknown as Window;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popup);
    cloudLoginDirectSpy.mockResolvedValue({
      ok: true,
      apiBase: "https://api.elizacloud.ai",
      browserUrl: "https://elizacloud.ai/auth/cli-login?session=sess-poll",
      sessionId: "sess-poll",
    });
    cloudLoginPollDirectSpy.mockResolvedValue({
      status: "authenticated",
      token: "session-token",
      userId: "user-1",
    });

    try {
      const { result, unmount } = renderHook(() => useCloudState(makeParams()));
      let login: Promise<void> = Promise.resolve();
      await act(async () => {
        login = result.current.handleCloudLogin(popup);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(popup.location.href).toBe(
        "https://elizacloud.ai/auth/cli-login?session=sess-poll",
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        await login;
      });

      expect(localStorage.getItem("steward_session_token")).toBe(
        "session-token",
      );
      expect(popup.close).toHaveBeenCalled();
      expect(openSpy).toHaveBeenCalledWith("", CLOUD_LOGIN_POPUP_NAME);

      unmount();
      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does one final direct cloud poll at the timeout boundary before timing out", async () => {
    vi.useFakeTimers();
    const popup = {
      closed: false,
      close: vi.fn(() => {
        (popup as { closed: boolean }).closed = true;
      }),
      location: { href: "" },
      opener: {},
    } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    cloudLoginDirectSpy.mockResolvedValue({
      ok: true,
      apiBase: "https://api.elizacloud.ai",
      browserUrl: "https://elizacloud.ai/auth/cli-login?session=sess-last",
      sessionId: "sess-last",
    });
    cloudLoginPollDirectSpy.mockResolvedValue({
      status: "authenticated",
      token: "last-poll-token",
      userId: "user-1",
    });

    try {
      const { result, unmount } = renderHook(() => useCloudState(makeParams()));
      let login: Promise<void> = Promise.resolve();
      await act(async () => {
        login = result.current.handleCloudLogin(popup);
        await Promise.resolve();
        await Promise.resolve();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300_000);
        await login;
      });

      expect(cloudLoginPollDirectSpy).toHaveBeenCalledWith(
        "https://api.elizacloud.ai",
        "sess-last",
      );
      expect(localStorage.getItem("steward_session_token")).toBe(
        "last-poll-token",
      );
      expect(result.current.elizaCloudLoginError).toBeNull();

      unmount();
      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a closeable named popup for localhost direct cloud login without a pre-opened handle", async () => {
    vi.useFakeTimers();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        href: "http://localhost:2138/chat",
        protocol: "http:",
        hostname: "localhost",
        port: "2138",
        pathname: "/chat",
        search: "",
        assign: assignSpy,
      },
    });
    const popup = {
      closed: false,
      close: vi.fn(() => {
        (popup as { closed: boolean }).closed = true;
      }),
      location: { href: "" },
      opener: {},
    } as unknown as Window;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popup);
    cloudLoginDirectSpy.mockResolvedValue({
      ok: true,
      apiBase: "https://api.elizacloud.ai",
      browserUrl: "https://elizacloud.ai/auth/cli-login?session=sess-local",
      sessionId: "sess-local",
    });
    cloudLoginPollDirectSpy.mockResolvedValue({
      status: "authenticated",
      token: "session-token",
      userId: "user-1",
    });

    try {
      const { result, unmount } = renderHook(() => useCloudState(makeParams()));
      let login: Promise<void> = Promise.resolve();
      await act(async () => {
        login = result.current.handleCloudLogin(null);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(openSpy).toHaveBeenCalledWith(
        "https://elizacloud.ai/auth/cli-login?session=sess-local",
        CLOUD_LOGIN_POPUP_NAME,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        await login;
      });

      expect(localStorage.getItem("steward_session_token")).toBe(
        "session-token",
      );
      expect(popup.close).toHaveBeenCalled();
      expect(openSpy).toHaveBeenCalledWith("", CLOUD_LOGIN_POPUP_NAME);

      unmount();
      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bypasses a registered Steward launcher on Capacitor native and uses external direct device-code polling", async () => {
    vi.useFakeTimers();
    globalWithPlatform.Capacitor = { isNativePlatform: () => true };
    const launcher = vi.fn(async () => ({ token: "launcher-token" }));
    const unregister = registerStewardLoginLauncher(launcher);
    const popup = {
      closed: false,
      close: vi.fn(() => {
        (popup as { closed: boolean }).closed = true;
      }),
      location: { href: "" },
      opener: {},
    } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    cloudLoginDirectSpy.mockResolvedValue({
      ok: true,
      apiBase: "https://api.elizacloud.ai",
      browserUrl: "https://elizacloud.ai/auth/cli-login?session=sess-native",
      sessionId: "sess-native",
    });
    cloudLoginPollDirectSpy.mockResolvedValue({
      status: "authenticated",
      token: "native-session-token",
      userId: "user-native",
    });

    try {
      const { result, unmount } = renderHook(() => useCloudState(makeParams()));
      let login: Promise<void> = Promise.resolve();
      await act(async () => {
        login = result.current.handleCloudLogin(popup);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(launcher).not.toHaveBeenCalled();
      expect(cloudLoginDirectSpy).toHaveBeenCalledWith(
        "https://api.elizacloud.ai",
      );
      expect(popup.location.href).toBe(
        "https://elizacloud.ai/auth/cli-login?session=sess-native",
      );
      expect(result.current.elizaCloudLoginFallbackUrl).toBe(
        "https://elizacloud.ai/auth/cli-login?session=sess-native",
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        await login;
      });

      expect(cloudLoginPollDirectSpy).toHaveBeenCalledWith(
        "https://api.elizacloud.ai",
        "sess-native",
      );
      expect(localStorage.getItem("steward_session_token")).toBe(
        "native-session-token",
      );

      unmount();
      vi.clearAllTimers();
    } finally {
      unregister();
      vi.useRealTimers();
    }
  });
});

// The same-tab login leg lands back in the app with only a session token; the
// visible connected/credits state comes from the next pollCloudCredits pass.
// These pin that snapshot application: connected+balance, auth-rejected, and
// the disconnected reset — never a fabricated healthy-empty.
describe("useCloudState — pollCloudCredits status snapshot", () => {
  let getCloudStatusSpy: ReturnType<typeof vi.spyOn>;
  let getCloudCreditsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    // Capacitor-native satisfies canPollCloudStatus() without a configured base.
    globalWithPlatform.Capacitor = { isNativePlatform: () => true };
    getCloudStatusSpy = vi.spyOn(client, "getCloudStatus");
    getCloudCreditsSpy = vi.spyOn(client, "getCloudCredits");
  });

  afterEach(() => {
    localStorage.clear();
    delete globalWithPlatform.Capacitor;
    vi.restoreAllMocks();
  });

  it("applies a connected snapshot: enabled, credits balance, low/critical flags, and status reason", async () => {
    getCloudStatusSpy.mockResolvedValue({
      enabled: true,
      connected: true,
      hasApiKey: true,
      cloudVoiceProxyAvailable: true,
      userId: "user-9",
      reason: " degraded upstream ",
      topUpUrl: "https://elizacloud.ai/top-up",
    });
    getCloudCreditsSpy.mockResolvedValue({
      balance: 12.5,
      low: true,
      critical: false,
    });

    const { result, unmount } = renderHook(() => useCloudState(makeParams()));
    let connected = false;
    await act(async () => {
      connected = await result.current.pollCloudCredits();
    });

    expect(connected).toBe(true);
    expect(result.current.elizaCloudConnected).toBe(true);
    expect(result.current.elizaCloudEnabled).toBe(true);
    expect(result.current.elizaCloudUserId).toBe("user-9");
    expect(result.current.elizaCloudStatusReason).toBe("degraded upstream");
    expect(result.current.elizaCloudTopUpUrl).toBe(
      "https://elizacloud.ai/top-up",
    );
    expect(result.current.elizaCloudCredits).toBe(12.5);
    expect(result.current.elizaCloudCreditsLow).toBe(true);
    expect(result.current.elizaCloudCreditsCritical).toBe(false);
    expect(result.current.elizaCloudAuthRejected).toBe(false);
    expect(result.current.elizaCloudCreditsError).toBeNull();

    unmount();
  });

  it("marks the session auth-rejected from the credits probe without fabricating a balance", async () => {
    getCloudStatusSpy.mockResolvedValue({
      enabled: true,
      connected: true,
      hasApiKey: true,
      cloudVoiceProxyAvailable: false,
    });
    getCloudCreditsSpy.mockResolvedValue({
      authRejected: true,
      topUpUrl: "https://elizacloud.ai/top-up",
    });

    const { result, unmount } = renderHook(() => useCloudState(makeParams()));
    await act(async () => {
      await result.current.pollCloudCredits();
    });

    expect(result.current.elizaCloudAuthRejected).toBe(true);
    expect(result.current.elizaCloudCredits).toBeNull();
    expect(result.current.elizaCloudCreditsLow).toBe(false);
    expect(result.current.elizaCloudCreditsError).toBeNull();

    unmount();
  });

  it("carries a credits transport failure into the visible error state, never healthy-empty", async () => {
    getCloudStatusSpy.mockResolvedValue({
      enabled: true,
      connected: true,
      hasApiKey: true,
      cloudVoiceProxyAvailable: false,
    });
    getCloudCreditsSpy.mockRejectedValue(new Error("credits endpoint down"));

    const { result, unmount } = renderHook(() => useCloudState(makeParams()));
    await act(async () => {
      await result.current.pollCloudCredits();
    });

    expect(result.current.elizaCloudCreditsError).toBe("credits endpoint down");
    expect(result.current.elizaCloudCredits).toBeNull();
    expect(result.current.elizaCloudAuthRejected).toBe(false);

    unmount();
  });

  it("resets credits and error state on a disconnected snapshot", async () => {
    getCloudStatusSpy.mockResolvedValue({
      enabled: false,
      connected: false,
      hasApiKey: false,
      cloudVoiceProxyAvailable: false,
    });

    const { result, unmount } = renderHook(() => useCloudState(makeParams()));
    let connected = true;
    await act(async () => {
      connected = await result.current.pollCloudCredits();
    });

    expect(connected).toBe(false);
    expect(result.current.elizaCloudConnected).toBe(false);
    expect(result.current.elizaCloudCredits).toBeNull();
    expect(result.current.elizaCloudCreditsError).toBeNull();
    expect(result.current.elizaCloudAuthRejected).toBe(false);
    expect(result.current.elizaCloudStatusReason).toBeNull();
    expect(getCloudCreditsSpy).not.toHaveBeenCalled();

    unmount();
  });
});
