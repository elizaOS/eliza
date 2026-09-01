/** Verifies useCloudState — handleCloudLogin same-tab fallback on hosted web through the package's configured test harness. */
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
import { getBootConfig, setBootConfig } from "../config/boot-config";
import {
  markCloudLoginPending,
  readCloudLoginPending,
} from "../first-run/first-run-cloud-resume";
import {
  __resetPreparedDesktopCloudLoginSessionForTests,
  CLOUD_LOGIN_POPUP_NAME,
  prepareDesktopCloudLoginSession,
} from "./cloud-login-launch";
import { registerStewardLoginLauncher } from "./cloud-steward-login";
import { savePersistedActiveServer } from "./persistence";
import { useCloudState } from "./useCloudState";

const DEVICE_CODE_SENTINEL = "device-code-flow-reached";
const originalBootConfig = structuredClone(getBootConfig());
const originalLocationDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "location",
);
const globalWithPlatform = globalThis as typeof globalThis & {
  Capacitor?: { isNativePlatform?: () => boolean };
};
const runtimeWithPinnedRemote = globalThis as typeof globalThis & {
  __ELIZA_BUILD_CONFIGURED_REMOTE_API_BASE__?: string;
};
const originalPinnedRemote =
  runtimeWithPinnedRemote.__ELIZA_BUILD_CONFIGURED_REMOTE_API_BASE__;
const windowWithElectrobun = window as Window & {
  __electrobunWindowId?: number;
  __ELIZA_DESKTOP_RUNTIME_MODE__?: string;
  __ELIZA_ELECTROBUN_RPC__?: {
    request: Record<string, (params?: unknown) => Promise<unknown>>;
    onMessage: (name: string, listener: (payload: unknown) => void) => void;
    offMessage: (name: string, listener: (payload: unknown) => void) => void;
  };
};

function makeParams() {
  return {
    setActionNotice: vi.fn(),
    loadWalletConfig: vi.fn(async () => {}),
    t: (key: string) => key,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    text: async () => JSON.stringify(body),
  } as Response;
}

function restorePinnedRemote(): void {
  if (originalPinnedRemote === undefined) {
    delete runtimeWithPinnedRemote.__ELIZA_BUILD_CONFIGURED_REMOTE_API_BASE__;
  } else {
    runtimeWithPinnedRemote.__ELIZA_BUILD_CONFIGURED_REMOTE_API_BASE__ =
      originalPinnedRemote;
  }
}

describe("useCloudState — handleCloudLogin same-tab fallback on hosted web", () => {
  let assignSpy: ReturnType<typeof vi.fn>;
  let cloudLoginSpy: ReturnType<typeof vi.spyOn>;
  let cloudLoginDirectSpy: ReturnType<typeof vi.spyOn>;
  let cloudLoginPollDirectSpy: ReturnType<typeof vi.spyOn>;
  let setBaseUrlSpy: ReturnType<typeof vi.spyOn>;
  let setTokenSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    setBootConfig(structuredClone(originalBootConfig));
    // jsdom's window.focus logs "Not implemented" through console.error; the
    // auth-return path calls it best-effort, so stub it out of the run.
    vi.spyOn(window, "focus").mockImplementation(() => {});
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
    setBaseUrlSpy = vi
      .spyOn(client, "setBaseUrl")
      .mockImplementation(() => undefined);
    setTokenSpy = vi
      .spyOn(client, "setToken")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    localStorage.clear();
    setBootConfig(structuredClone(originalBootConfig));
    delete globalWithPlatform.Capacitor;
    delete windowWithElectrobun.__electrobunWindowId;
    delete windowWithElectrobun.__ELIZA_DESKTOP_RUNTIME_MODE__;
    delete windowWithElectrobun.__ELIZA_ELECTROBUN_RPC__;
    restorePinnedRemote();
    __resetPreparedDesktopCloudLoginSessionForTests();
    vi.unstubAllEnvs();
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

  it("uses a hosted staging session with a local backend and preserves that backend after success", async () => {
    vi.useFakeTimers();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        href: "http://127.0.0.1:2189/settings",
        origin: "http://127.0.0.1:2189",
        protocol: "http:",
        hostname: "127.0.0.1",
        port: "2189",
        pathname: "/settings",
        search: "",
        assign: assignSpy,
      },
    });
    vi.stubEnv("VITE_STEWARD_API_URL", "https://staging.eliza.app/steward");
    vi.stubEnv("VITE_STEWARD_TENANT_ID", "elizacloud-staging");
    setBootConfig({
      branding: {},
      cloudApiBase: "https://api-staging.eliza.app",
    });
    vi.spyOn(client, "getBaseUrl").mockReturnValue("http://127.0.0.1:31337");
    const getCloudStatusSpy = vi
      .spyOn(client, "getCloudStatus")
      .mockResolvedValue({
        connected: false,
        enabled: true,
      } as Awaited<ReturnType<typeof client.getCloudStatus>>);
    const popup = {
      closed: false,
      close: vi.fn(() => {
        (popup as { closed: boolean }).closed = true;
      }),
      location: { href: "" },
      opener: {},
    } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    const browserUrl =
      "https://staging.eliza.app/auth/cli-login?session=hosted-session&returnTo=http%3A%2F%2F127.0.0.1%3A2189%2Fsettings%3FelizaCloudLogin%3Dcomplete%26elizaCloudLoginSession%3Dhosted-session";
    cloudLoginDirectSpy.mockResolvedValue({
      ok: true,
      apiBase: "https://api-staging.eliza.app",
      browserUrl,
      sessionId: "hosted-session",
    });
    cloudLoginPollDirectSpy.mockResolvedValue({
      status: "authenticated",
      token: "staging-session-token",
      organizationId: "org-staging",
      userId: "user-staging",
    });

    try {
      const { result, unmount } = renderHook(() => useCloudState(makeParams()));
      let login: Promise<void> | undefined;
      await act(async () => {
        login = result.current.handleCloudLogin(popup);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(getCloudStatusSpy).toHaveBeenCalled();
      expect(cloudLoginDirectSpy).toHaveBeenCalledWith(
        "https://api-staging.eliza.app",
      );
      expect(cloudLoginSpy).not.toHaveBeenCalled();
      expect(assignSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("/login?returnTo="),
      );
      expect(popup.location.href).toBe(browserUrl);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
        await login;
      });

      expect(cloudLoginPollDirectSpy).toHaveBeenCalledWith(
        "https://api-staging.eliza.app",
        "hosted-session",
      );
      expect(localStorage.getItem("steward_session_token")).toBe(
        "staging-session-token",
      );
      expect(setBaseUrlSpy).not.toHaveBeenCalled();
      expect(setTokenSpy).not.toHaveBeenCalled();
      expect(result.current.elizaCloudConnected).toBe(true);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("navigates popup-hostile loopback staging to the hosted CLI URL, never local /login", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        href: "http://127.0.0.1:2189/settings",
        origin: "http://127.0.0.1:2189",
        protocol: "http:",
        hostname: "127.0.0.1",
        port: "2189",
        pathname: "/settings",
        search: "",
        assign: assignSpy,
      },
    });
    vi.stubEnv("VITE_STEWARD_API_URL", "https://staging.eliza.app/steward");
    vi.stubEnv("VITE_STEWARD_TENANT_ID", "elizacloud-staging");
    setBootConfig({
      branding: {},
      cloudApiBase: "https://api-staging.eliza.app",
    });
    vi.spyOn(client, "getBaseUrl").mockReturnValue("http://127.0.0.1:31337");
    vi.spyOn(client, "getCloudStatus").mockResolvedValue({
      connected: false,
      enabled: true,
    } as Awaited<ReturnType<typeof client.getCloudStatus>>);
    const browserUrl =
      "https://staging.eliza.app/auth/cli-login?session=hosted-session&returnTo=http%3A%2F%2F127.0.0.1%3A2189%2Fsettings%3FelizaCloudLogin%3Dcomplete%26elizaCloudLoginSession%3Dhosted-session";
    cloudLoginDirectSpy.mockResolvedValue({
      ok: true,
      apiBase: "https://api-staging.eliza.app",
      browserUrl,
      sessionId: "hosted-session",
    });

    const { result } = renderHook(() => useCloudState(makeParams()));
    await act(async () => {
      await result.current.handleCloudLogin(null);
    });

    expect(cloudLoginDirectSpy).toHaveBeenCalledTimes(1);
    expect(cloudLoginSpy).not.toHaveBeenCalled();
    expect(assignSpy).toHaveBeenCalledWith(browserUrl);
    expect(assignSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("/login?returnTo="),
    );
    const returnTo = new URL(browserUrl).searchParams.get("returnTo");
    expect(returnTo).toContain("http://127.0.0.1:2189/settings");
    expect(setBaseUrlSpy).not.toHaveBeenCalled();
    expect(setTokenSpy).not.toHaveBeenCalled();
  });

  it("keeps production loopback on the agent-proxied device-code flow", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        href: "http://127.0.0.1:2189/settings",
        origin: "http://127.0.0.1:2189",
        protocol: "http:",
        hostname: "127.0.0.1",
        port: "2189",
        pathname: "/settings",
        search: "",
        assign: assignSpy,
      },
    });
    vi.stubEnv("VITE_STEWARD_API_URL", "https://eliza.app/steward");
    vi.stubEnv("VITE_STEWARD_TENANT_ID", "elizacloud");
    vi.spyOn(client, "getBaseUrl").mockReturnValue("http://127.0.0.1:31337");
    vi.spyOn(client, "getCloudStatus").mockResolvedValue({
      connected: false,
      enabled: true,
    } as Awaited<ReturnType<typeof client.getCloudStatus>>);
    const popup = {
      closed: false,
      close: vi.fn(),
      location: { href: "" },
      opener: {},
    } as unknown as Window;

    const { result } = renderHook(() => useCloudState(makeParams()));
    await act(async () => {
      await result.current.handleCloudLogin(popup);
    });

    expect(assignSpy).not.toHaveBeenCalled();
    expect(cloudLoginSpy).toHaveBeenCalledTimes(1);
    expect(cloudLoginDirectSpy).not.toHaveBeenCalled();
    expect(result.current.elizaCloudLoginError).toBe(DEVICE_CODE_SENTINEL);
  });

  it("uses Electrobun's external-browser RPC instead of a renderer popup", async () => {
    const browserUrl = "https://eliza.app/auth/cli-login?session=desktop";
    const desktopOpenExternal = vi.fn().mockResolvedValue(undefined);
    windowWithElectrobun.__electrobunWindowId = 1;
    windowWithElectrobun.__ELIZA_ELECTROBUN_RPC__ = {
      request: { desktopOpenExternal },
      onMessage: vi.fn(),
      offMessage: vi.fn(),
    };
    cloudLoginDirectSpy.mockResolvedValue({
      ok: true,
      apiBase: "https://api.eliza.app",
      browserUrl,
      sessionId: "desktop",
    });
    const openSpy = vi.spyOn(window, "open");
    const { result, unmount } = renderHook(() => useCloudState(makeParams()));

    await act(async () => {
      void result.current.handleCloudLogin(null);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(desktopOpenExternal).toHaveBeenCalledWith({ url: browserUrl });
    });
    expect(openSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
    unmount();
  });

  it("opens from a prepared desktop session without another click-time network round-trip", async () => {
    const browserUrl =
      "https://eliza.app/auth/cli-login?session=desktop-prepared";
    const desktopOpenExternal = vi.fn().mockResolvedValue(undefined);
    windowWithElectrobun.__electrobunWindowId = 1;
    windowWithElectrobun.__ELIZA_ELECTROBUN_RPC__ = {
      request: { desktopOpenExternal },
      onMessage: vi.fn(),
      offMessage: vi.fn(),
    };
    cloudLoginDirectSpy.mockResolvedValue({
      ok: true,
      apiBase: "https://api.eliza.app",
      browserUrl,
      sessionId: "desktop-prepared",
    });

    const prepared = prepareDesktopCloudLoginSession("https://eliza.app", () =>
      client.cloudLoginDirect("https://eliza.app"),
    );
    await prepared;
    expect(cloudLoginDirectSpy).toHaveBeenCalledTimes(1);

    const { result, unmount } = renderHook(() => useCloudState(makeParams()));
    await act(async () => {
      void result.current.handleCloudLogin(null, { requireClientAuth: true });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(desktopOpenExternal).toHaveBeenCalledWith({ url: browserUrl });
    });
    expect(cloudLoginDirectSpy).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("does not navigate the auth popup until CLI-session creation completes", async () => {
    vi.useFakeTimers();
    const popup = {
      closed: false,
      close: vi.fn(),
      location: { href: "" },
      opener: {},
    } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    type DirectLoginResult = Awaited<
      ReturnType<typeof client.cloudLoginDirect>
    >;
    let resolveSession: ((value: DirectLoginResult) => void) | undefined;
    cloudLoginDirectSpy.mockReturnValue(
      new Promise<DirectLoginResult>((resolve) => {
        resolveSession = resolve;
      }),
    );

    try {
      const { result, unmount } = renderHook(() => useCloudState(makeParams()));
      await act(async () => {
        void result.current.handleCloudLogin(popup);
        await Promise.resolve();
      });

      expect(cloudLoginDirectSpy).toHaveBeenCalledTimes(1);
      expect(popup.location.href).toBe("");

      await act(async () => {
        resolveSession?.({
          ok: true,
          apiBase: "https://api.elizacloud.ai",
          browserUrl:
            "https://elizacloud.ai/auth/cli-login?session=sess-serialized",
          sessionId: "sess-serialized",
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(popup.location.href).toBe(
        "https://elizacloud.ai/auth/cli-login?session=sess-serialized",
      );
      expect(assignSpy).not.toHaveBeenCalled();

      unmount();
      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
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
        href: `https://cloud.eliza.app/chat${search}`,
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
      "https://api.eliza.app",
      "sess-return",
    );
    expect(params.setActionNotice).not.toHaveBeenCalled();
  });

  it("claims a hosted staging return without replacing the localhost backend", async () => {
    const search =
      "?elizaCloudLogin=complete&elizaCloudLoginSession=staging-return";
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        href: `http://127.0.0.1:2189/settings${search}`,
        origin: "http://127.0.0.1:2189",
        protocol: "http:",
        hostname: "127.0.0.1",
        port: "2189",
        pathname: "/settings",
        search,
        assign: assignSpy,
      },
    });
    vi.stubEnv("VITE_STEWARD_API_URL", "https://staging.eliza.app/steward");
    vi.stubEnv("VITE_STEWARD_TENANT_ID", "elizacloud-staging");
    setBootConfig({
      branding: {},
      cloudApiBase: "https://api-staging.eliza.app",
    });
    vi.spyOn(client, "getBaseUrl").mockReturnValue("http://127.0.0.1:31337");
    cloudLoginPollDirectSpy.mockResolvedValue({
      status: "authenticated",
      organizationId: "org-staging",
      token: "staging-return-token",
      userId: "user-staging",
    });

    const { result } = renderHook(() => useCloudState(makeParams()));

    await waitFor(() => {
      expect(localStorage.getItem("steward_session_token")).toBe(
        "staging-return-token",
      );
      expect(result.current.elizaCloudConnected).toBe(true);
    });
    expect(cloudLoginPollDirectSpy).toHaveBeenCalledWith(
      "https://api-staging.eliza.app",
      "staging-return",
    );
    expect(setBaseUrlSpy).not.toHaveBeenCalled();
    expect(setTokenSpy).not.toHaveBeenCalled();
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
      apiBase: "https://api.eliza.app/api/v1",
      browserUrl: "https://eliza.app/auth/cli-login?session=sess-1",
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
        "https://eliza.app/auth/cli-login?session=sess-1",
      );
      expect((popup as unknown as { opener: unknown }).opener).toBe(opener);

      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: "https://eliza.app",
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
            origin: "https://eliza.app",
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

  it("uses direct Cloud auth when cloud-only Electrobun serves assets from loopback", async () => {
    vi.useFakeTimers();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        href: "http://127.0.0.1:5174/?shellMode=chat-overlay",
        origin: "http://127.0.0.1:5174",
        protocol: "http:",
        hostname: "127.0.0.1",
        port: "5174",
        pathname: "/",
        search: "?shellMode=chat-overlay",
        assign: assignSpy,
      },
    });
    windowWithElectrobun.__electrobunWindowId = 1;
    windowWithElectrobun.__ELIZA_DESKTOP_RUNTIME_MODE__ = "cloud";
    windowWithElectrobun.__ELIZA_ELECTROBUN_RPC__ = {
      request: {
        openExternal: vi.fn(async () => ({ opened: true })),
      },
      onMessage: vi.fn(),
      offMessage: vi.fn(),
    };
    vi.spyOn(client, "getBaseUrl").mockReturnValue("http://127.0.0.1:5174");
    cloudLoginDirectSpy.mockResolvedValue({
      ok: true,
      apiBase: "https://api.eliza.app",
      browserUrl: "https://eliza.app/auth/cli-login?session=sess-desktop",
      sessionId: "sess-desktop",
    });
    cloudLoginPollDirectSpy.mockResolvedValue({
      status: "pending",
    });

    try {
      const { result, unmount } = renderHook(() => useCloudState(makeParams()));
      await act(async () => {
        void result.current.handleCloudLogin(null);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(cloudLoginSpy).not.toHaveBeenCalled();
      expect(cloudLoginDirectSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(cloudLoginPollDirectSpy).toHaveBeenCalledWith(
        "https://api.eliza.app",
        "sess-desktop",
      );

      unmount();
      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bypasses a registered Steward launcher on Capacitor native and uses external direct device-code polling", async () => {
    vi.useFakeTimers();
    globalWithPlatform.Capacitor = { isNativePlatform: () => true };
    setBootConfig({
      branding: {},
      cloudApiBase: "https://api.elizacloud.ai",
    });
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

  it("verifies a pinned-remote login only against the Cloud control plane and preserves the ambient snapshot without polling", async () => {
    runtimeWithPinnedRemote.__ELIZA_BUILD_CONFIGURED_REMOTE_API_BASE__ =
      "https://bot.nubs.site";
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        href: "http://localhost:2138/settings",
        origin: "http://localhost:2138",
        protocol: "http:",
        hostname: "localhost",
        port: "2138",
        pathname: "/settings",
        search: "",
        assign: assignSpy,
      },
    });
    setBootConfig({
      branding: {},
      cloudApiBase: "https://api-staging.eliza.app",
    });
    const stewardToken = "steward-session-token";
    const requests: Array<{ init?: RequestInit; url: string }> = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          requests.push({ init, url });
          if (url === "https://api-staging.eliza.app/api/v1/user") {
            return jsonResponse(200, {
              data: { id: "user-pinned", organization_id: "org-pinned" },
            });
          }
          if (url === "https://api-staging.eliza.app/api/v1/credits/balance") {
            return jsonResponse(200, { balance: 8.5 });
          }
          throw new Error(`unexpected request: ${url}`);
        },
      );
    const agentStatusSpy = vi.spyOn(client, "getCloudStatus");
    const agentCreditsSpy = vi.spyOn(client, "getCloudCredits");
    const launcher = vi.fn(async () => {
      localStorage.setItem("steward_session_token", stewardToken);
      return { token: stewardToken };
    });
    const unregister = registerStewardLoginLauncher(launcher);

    try {
      const { result, unmount } = renderHook(() => useCloudState(makeParams()));

      let ambientConnected = true;
      await act(async () => {
        ambientConnected = await result.current.pollCloudCredits();
      });
      expect(ambientConnected).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(agentStatusSpy).not.toHaveBeenCalled();
      expect(agentCreditsSpy).not.toHaveBeenCalled();
      expect(result.current.elizaCloudPollInterval.current).toBeNull();

      await act(async () => {
        await result.current.handleCloudLogin();
      });

      expect(launcher).toHaveBeenCalledTimes(1);
      expect(result.current.elizaCloudConnected).toBe(true);
      expect(result.current.elizaCloudCredits).toBe(8.5);
      expect(result.current.elizaCloudUserId).toBe("user-pinned");
      expect(result.current.elizaCloudLoginError).toBeNull();
      expect(requests.map(({ url }) => url)).toEqual([
        "https://api-staging.eliza.app/api/v1/user",
        "https://api-staging.eliza.app/api/v1/credits/balance",
      ]);
      for (const request of requests) {
        expect(new Headers(request.init?.headers).get("Authorization")).toBe(
          `Bearer ${stewardToken}`,
        );
      }
      expect(setBaseUrlSpy).not.toHaveBeenCalled();
      expect(setTokenSpy).not.toHaveBeenCalled();
      expect(agentStatusSpy).not.toHaveBeenCalled();
      expect(agentCreditsSpy).not.toHaveBeenCalled();
      expect(result.current.elizaCloudPollInterval.current).toBeNull();

      fetchSpy.mockClear();
      await act(async () => {
        ambientConnected = await result.current.pollCloudCredits();
      });
      expect(ambientConnected).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.current.lastElizaCloudPollConnectedRef.current).toBe(true);
      expect(result.current.elizaCloudPollInterval.current).toBeNull();
      unmount();
    } finally {
      unregister();
    }
  });

  it("fails pinned-remote login verification on a control-plane 401", async () => {
    runtimeWithPinnedRemote.__ELIZA_BUILD_CONFIGURED_REMOTE_API_BASE__ =
      "https://bot.nubs.site";
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        href: "http://localhost:2138/settings",
        origin: "http://localhost:2138",
        protocol: "http:",
        hostname: "localhost",
        port: "2138",
        pathname: "/settings",
        search: "",
        assign: assignSpy,
      },
    });
    setBootConfig({
      branding: {},
      cloudApiBase: "https://api-staging.eliza.app",
    });
    const stewardToken = "rejected-steward-session-token";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(401, { error: "unauthorized" }));
    const launcher = vi.fn(async () => {
      localStorage.setItem("steward_session_token", stewardToken);
      return { token: stewardToken };
    });
    const unregister = registerStewardLoginLauncher(launcher);

    try {
      const { result, unmount } = renderHook(() => useCloudState(makeParams()));
      await act(async () => {
        await result.current.handleCloudLogin();
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result.current.elizaCloudConnected).toBe(false);
      expect(result.current.elizaCloudLoginError).toBe(
        "Could not verify your Eliza Cloud session. Please sign in again.",
      );
      expect(localStorage.getItem("steward_session_token")).toBeNull();
      expect(result.current.elizaCloudPollInterval.current).toBeNull();
      unmount();
    } finally {
      unregister();
    }
  });

  it("keeps the pinned Steward token on a transient verification failure", async () => {
    runtimeWithPinnedRemote.__ELIZA_BUILD_CONFIGURED_REMOTE_API_BASE__ =
      "https://bot.nubs.site";
    setBootConfig({
      branding: {},
      cloudApiBase: "https://api-staging.eliza.app",
    });
    const stewardToken = "durable-steward-session-token";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(503, { error: "temporarily unavailable" }),
      );
    const launcher = vi.fn(async () => {
      localStorage.setItem("steward_session_token", stewardToken);
      return { token: stewardToken };
    });
    const unregister = registerStewardLoginLauncher(launcher);

    try {
      const { result, unmount } = renderHook(() => useCloudState(makeParams()));
      await act(async () => {
        await result.current.handleCloudLogin();
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result.current.elizaCloudConnected).toBe(false);
      expect(result.current.elizaCloudLoginError).toBe(
        "Eliza Cloud is temporarily unavailable. Retry in a moment.",
      );
      expect(result.current.elizaCloudLoginError).not.toContain(
        "sign in again",
      );
      expect(localStorage.getItem("steward_session_token")).toBe(stewardToken);
      expect(result.current.elizaCloudPollInterval.current).toBeNull();

      let requiredClientAuthFailure: unknown;
      await act(async () => {
        try {
          await result.current.handleCloudLogin(null, {
            requireClientAuth: true,
          });
        } catch (error) {
          requiredClientAuthFailure = error;
        }
      });
      expect(requiredClientAuthFailure).toMatchObject({
        message: "Eliza Cloud is temporarily unavailable. Retry in a moment.",
        name: "CloudSessionVerificationTransientError",
      });
      expect(localStorage.getItem("steward_session_token")).toBe(stewardToken);
      unmount();
    } finally {
      unregister();
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
    restorePinnedRemote();
    vi.restoreAllMocks();
  });

  it("does not poll a selected remote runtime's unrelated Cloud billing state", async () => {
    expect(
      savePersistedActiveServer({
        id: "remote-vps",
        kind: "remote",
        label: "Eliza VPS",
        apiBase: "https://bot.nubs.site",
        accessToken: "paired-test-token",
      }),
    ).toBe(true);
    getCloudStatusSpy.mockResolvedValue({
      enabled: true,
      connected: true,
      hasApiKey: true,
      cloudVoiceProxyAvailable: false,
    });
    getCloudCreditsSpy.mockResolvedValue({ authRejected: true });

    const { result, unmount } = renderHook(() => useCloudState(makeParams()));
    let connected = true;
    await act(async () => {
      connected = await result.current.pollCloudCredits();
    });

    expect(connected).toBe(false);
    expect(getCloudStatusSpy).not.toHaveBeenCalled();
    expect(getCloudCreditsSpy).not.toHaveBeenCalled();
    expect(result.current.elizaCloudAuthRejected).toBe(false);
    expect(result.current.elizaCloudPollInterval.current).toBeNull();
    unmount();
  });

  it("does not poll Cloud billing for a build-pinned self-hosted runtime", async () => {
    runtimeWithPinnedRemote.__ELIZA_BUILD_CONFIGURED_REMOTE_API_BASE__ =
      "https://bot.nubs.site";

    const { result, unmount } = renderHook(() => useCloudState(makeParams()));
    await act(async () => {
      await result.current.pollCloudCredits();
    });

    expect(getCloudStatusSpy).not.toHaveBeenCalled();
    expect(getCloudCreditsSpy).not.toHaveBeenCalled();
    unmount();
  });

  it("keeps polling for a Cloud-managed active runtime", async () => {
    expect(
      savePersistedActiveServer({
        id: "cloud-personal",
        kind: "cloud",
        label: "Eliza Cloud",
        cloudRuntime: "dedicated",
      }),
    ).toBe(true);
    getCloudStatusSpy.mockResolvedValue({
      enabled: true,
      connected: false,
      hasApiKey: false,
      cloudVoiceProxyAvailable: false,
    });

    const { result, unmount } = renderHook(() => useCloudState(makeParams()));
    await act(async () => {
      await result.current.pollCloudCredits();
    });

    expect(getCloudStatusSpy).toHaveBeenCalledTimes(1);
    unmount();
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
