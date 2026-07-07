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
import { useCloudState } from "./useCloudState";

const DEVICE_CODE_SENTINEL = "device-code-flow-reached";

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
  const originalLocationDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "location",
  );

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
    expect(params.setActionNotice).toHaveBeenCalledWith(
      "Logged in to Eliza Cloud successfully.",
      "success",
      6000,
    );
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
});
