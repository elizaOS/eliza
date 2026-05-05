// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  clientMock,
  closeExternalBrowserMock,
  dispatchElizaCloudStatusUpdatedMock,
  getBootConfigMock,
  invokeDesktopBridgeRequestWithTimeoutMock,
  isElectrobunRuntimeMock,
  navigatePreOpenedWindowMock,
  openExternalUrlMock,
  setBootConfigMock,
  yieldElizaHttpAfterNativeMessageBoxMock,
} = vi.hoisted(() => ({
  clientMock: {
    getBaseUrl: vi.fn(() => "http://127.0.0.1:31337"),
    getCloudStatus: vi.fn(),
    getCloudCredits: vi.fn(),
    cloudLogin: vi.fn(),
    cloudLoginPersist: vi.fn(),
    cloudLoginDirect: vi.fn(),
    cloudLoginPoll: vi.fn(),
    cloudLoginPollDirect: vi.fn(),
    setBaseUrl: vi.fn(),
    setToken: vi.fn(),
  },
  closeExternalBrowserMock: vi.fn(),
  dispatchElizaCloudStatusUpdatedMock: vi.fn(),
  getBootConfigMock: vi.fn(() => ({})),
  invokeDesktopBridgeRequestWithTimeoutMock: vi.fn(),
  isElectrobunRuntimeMock: vi.fn(() => false),
  navigatePreOpenedWindowMock: vi.fn(),
  openExternalUrlMock: vi.fn(),
  setBootConfigMock: vi.fn(),
  yieldElizaHttpAfterNativeMessageBoxMock: vi.fn(),
}));

vi.mock("../api", () => ({
  client: clientMock,
}));

vi.mock("../bridge", () => ({
  invokeDesktopBridgeRequestWithTimeout:
    invokeDesktopBridgeRequestWithTimeoutMock,
  isElectrobunRuntime: isElectrobunRuntimeMock,
}));

vi.mock("../config/boot-config", () => ({
  getBootConfig: getBootConfigMock,
  setBootConfig: setBootConfigMock,
}));

vi.mock("../events", () => ({
  dispatchElizaCloudStatusUpdated: dispatchElizaCloudStatusUpdatedMock,
}));

vi.mock("../utils", () => ({
  closeExternalBrowser: closeExternalBrowserMock,
  confirmDesktopAction: vi.fn(),
  isCloudStatusAuthenticated: (
    connected: boolean,
    reason: string | null | undefined,
  ) =>
    connected &&
    reason !== "api_key_present_not_authenticated" &&
    reason !== "api_key_present_runtime_not_started",
  openExternalUrl: openExternalUrlMock,
  navigatePreOpenedWindow: navigatePreOpenedWindowMock,
  yieldElizaHttpAfterNativeMessageBox: yieldElizaHttpAfterNativeMessageBoxMock,
}));

import { useCloudState } from "./useCloudState";

function createParams() {
  return {
    setActionNotice: vi.fn(),
    loadWalletConfig: vi.fn(async () => undefined),
    t: (key: string) => key,
  };
}

describe("useCloudState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, "setInterval").mockImplementation(() => 1 as never);
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    clientMock.getBaseUrl.mockReturnValue("http://127.0.0.1:31337");
    clientMock.getCloudCredits.mockResolvedValue({
      connected: true,
      balance: 11.13,
      low: false,
      critical: false,
    });
    clientMock.cloudLoginPersist.mockResolvedValue({ ok: true });
    clientMock.setBaseUrl.mockReturnValue(undefined);
    clientMock.setToken.mockReturnValue(undefined);
    getBootConfigMock.mockReturnValue({});
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("preserves the connected state when cloud status polling transiently fails", async () => {
    clientMock.getCloudStatus
      .mockResolvedValueOnce({
        connected: true,
        enabled: true,
        hasApiKey: true,
      })
      .mockRejectedValueOnce(new Error("backend restarting"));

    const { result } = renderHook(() => useCloudState(createParams()));

    await act(async () => {
      expect(await result.current.pollCloudCredits()).toBe(true);
    });

    await waitFor(() => {
      expect(result.current.elizaCloudConnected).toBe(true);
    });

    await act(async () => {
      expect(await result.current.pollCloudCredits()).toBe(true);
    });

    expect(result.current.elizaCloudConnected).toBe(true);
    expect(result.current.elizaCloudCredits).toBe(11.13);
  });

  it("reconciles with backend cloud status instead of starting a second login flow", async () => {
    clientMock.getCloudStatus.mockResolvedValue({
      connected: true,
      enabled: true,
      cloudVoiceProxyAvailable: true,
      hasApiKey: true,
      userId: "user_123",
    });

    const params = createParams();
    const { result } = renderHook(() => useCloudState(params));

    await act(async () => {
      await result.current.handleCloudLogin();
    });

    await waitFor(() => {
      expect(result.current.elizaCloudConnected).toBe(true);
    });

    expect(clientMock.cloudLogin).not.toHaveBeenCalled();
    expect(params.loadWalletConfig).toHaveBeenCalledTimes(1);
    expect(params.setActionNotice).toHaveBeenCalledWith(
      "Already connected to Eliza Cloud.",
      "info",
      4000,
    );
    expect(result.current.elizaCloudLoginBusy).toBe(false);
    expect(result.current.elizaCloudLoginError).toBeNull();
  });

  it("starts login when cloud status is API-key-only", async () => {
    clientMock.getCloudStatus.mockResolvedValue({
      connected: true,
      enabled: false,
      hasApiKey: true,
      reason: "api_key_present_not_authenticated",
    });
    clientMock.cloudLogin.mockResolvedValue({
      ok: true,
      sessionId: "session-api-key-only",
      browserUrl:
        "https://www.elizacloud.ai/auth/cli-login?session=session-api-key-only",
    });

    const { result } = renderHook(() => useCloudState(createParams()));

    await act(async () => {
      await result.current.handleCloudLogin();
    });

    expect(clientMock.cloudLogin).toHaveBeenCalledTimes(1);
    expect(openExternalUrlMock).toHaveBeenCalledWith(
      "https://www.elizacloud.ai/auth/cli-login?session=session-api-key-only",
    );
  });

  it("uses the same-origin local backend when no explicit API base URL is set", async () => {
    clientMock.getBaseUrl.mockReturnValue("");
    clientMock.getCloudStatus.mockResolvedValue({
      connected: false,
      enabled: false,
      hasApiKey: false,
    });
    clientMock.cloudLogin.mockResolvedValue({
      ok: true,
      sessionId: "session-1",
      browserUrl: "https://www.elizacloud.ai/auth/cli-login?session=session-1",
    });

    const { result } = renderHook(() => useCloudState(createParams()));

    await act(async () => {
      await result.current.handleCloudLogin();
    });

    expect(clientMock.cloudLogin).toHaveBeenCalledTimes(1);
    expect(clientMock.cloudLoginDirect).not.toHaveBeenCalled();
    expect(openExternalUrlMock).toHaveBeenCalledWith(
      "https://www.elizacloud.ai/auth/cli-login?session=session-1",
    );
  });

  it("uses direct Eliza Cloud auth on Capacitor native without a backend", async () => {
    (
      globalThis as { Capacitor?: { isNativePlatform: () => boolean } }
    ).Capacitor = { isNativePlatform: () => true };
    clientMock.getBaseUrl.mockReturnValue("");
    clientMock.cloudLoginDirect.mockResolvedValue({
      ok: true,
      sessionId: "mobile-session-1",
      browserUrl:
        "https://www.elizacloud.ai/auth/cli-login?session=mobile-session-1",
    });

    const { result } = renderHook(() => useCloudState(createParams()));

    await act(async () => {
      await result.current.handleCloudLogin();
    });

    expect(clientMock.cloudLoginDirect).toHaveBeenCalledWith(
      "https://www.elizacloud.ai",
    );
    expect(clientMock.cloudLogin).not.toHaveBeenCalled();
    expect(clientMock.getCloudStatus).not.toHaveBeenCalled();
    expect(openExternalUrlMock).toHaveBeenCalledWith(
      "https://www.elizacloud.ai/auth/cli-login?session=mobile-session-1",
    );
  });

  it("uses direct Eliza Cloud auth on Capacitor native when the API base is the bundled web origin", async () => {
    (
      globalThis as { Capacitor?: { isNativePlatform: () => boolean } }
    ).Capacitor = { isNativePlatform: () => true };
    clientMock.getBaseUrl.mockReturnValue("https://localhost");
    clientMock.cloudLoginDirect.mockResolvedValue({
      ok: true,
      sessionId: "mobile-session-localhost",
      browserUrl:
        "https://www.elizacloud.ai/auth/cli-login?session=mobile-session-localhost",
    });

    const { result } = renderHook(() => useCloudState(createParams()));

    await act(async () => {
      await result.current.handleCloudLogin();
    });

    expect(clientMock.cloudLoginDirect).toHaveBeenCalledWith(
      "https://www.elizacloud.ai",
    );
    expect(clientMock.cloudLogin).not.toHaveBeenCalled();
    expect(clientMock.getCloudStatus).not.toHaveBeenCalled();
    expect(openExternalUrlMock).toHaveBeenCalledWith(
      "https://www.elizacloud.ai/auth/cli-login?session=mobile-session-localhost",
    );
  });

  it("keeps using direct Eliza Cloud auth when the native client already points at the API host", async () => {
    (
      globalThis as { Capacitor?: { isNativePlatform: () => boolean } }
    ).Capacitor = { isNativePlatform: () => true };
    clientMock.getBaseUrl.mockReturnValue("https://api.elizacloud.ai");
    clientMock.cloudLoginDirect.mockResolvedValue({
      ok: true,
      apiBase: "https://api.elizacloud.ai",
      sessionId: "mobile-session-api-host",
      browserUrl:
        "https://www.elizacloud.ai/auth/cli-login?session=mobile-session-api-host",
    });

    const { result } = renderHook(() => useCloudState(createParams()));

    await act(async () => {
      await result.current.handleCloudLogin();
    });

    expect(clientMock.cloudLoginDirect).toHaveBeenCalledWith(
      "https://www.elizacloud.ai",
    );
    expect(clientMock.cloudLogin).not.toHaveBeenCalled();
    expect(clientMock.getCloudStatus).not.toHaveBeenCalled();
    expect(openExternalUrlMock).toHaveBeenCalledWith(
      "https://www.elizacloud.ai/auth/cli-login?session=mobile-session-api-host",
    );
  });

  it("keeps direct Eliza Cloud tokens client-side instead of persisting through a missing local backend", async () => {
    (
      globalThis as { Capacitor?: { isNativePlatform: () => boolean } }
    ).Capacitor = { isNativePlatform: () => true };
    clientMock.getBaseUrl.mockReturnValue("");
    getBootConfigMock.mockReturnValue({
      cloudApiBase: "https://www.elizacloud.ai",
    });
    clientMock.cloudLoginDirect.mockResolvedValue({
      ok: true,
      apiBase: "https://api.elizacloud.ai",
      sessionId: "mobile-session-2",
      browserUrl:
        "https://www.elizacloud.ai/auth/cli-login?session=mobile-session-2",
    });
    clientMock.cloudLoginPollDirect.mockResolvedValue({
      status: "authenticated",
      token: "eliza_mobile_key",
      userId: "user-mobile",
    });
    let tick: (() => void) | null = null;
    vi.mocked(window.setInterval).mockImplementation((callback) => {
      tick = callback as () => void;
      return 7 as never;
    });

    const { result } = renderHook(() => useCloudState(createParams()));

    await act(async () => {
      await result.current.handleCloudLogin();
    });
    await act(async () => {
      tick?.();
      await Promise.resolve();
    });

    expect(clientMock.cloudLoginPersist).not.toHaveBeenCalled();
    expect(clientMock.setBaseUrl).toHaveBeenCalledWith(
      "https://api.elizacloud.ai",
    );
    expect(setBootConfigMock).toHaveBeenCalledWith({
      cloudApiBase: "https://api.elizacloud.ai",
    });
    expect(clientMock.setToken).toHaveBeenCalledWith("eliza_mobile_key");
    expect(closeExternalBrowserMock).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(result.current.elizaCloudConnected).toBe(true);
      expect(result.current.elizaCloudUserId).toBe("user-mobile");
    });
  });
});
