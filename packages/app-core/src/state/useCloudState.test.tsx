// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  clientMock,
  dispatchElizaCloudStatusUpdatedMock,
  getBootConfigMock,
  invokeDesktopBridgeRequestWithTimeoutMock,
  isElectrobunRuntimeMock,
  openExternalUrlMock,
  setBootConfigMock,
  yieldMiladyHttpAfterNativeMessageBoxMock,
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
  },
  dispatchElizaCloudStatusUpdatedMock: vi.fn(),
  getBootConfigMock: vi.fn(() => ({})),
  invokeDesktopBridgeRequestWithTimeoutMock: vi.fn(),
  isElectrobunRuntimeMock: vi.fn(() => false),
  openExternalUrlMock: vi.fn(),
  setBootConfigMock: vi.fn(),
  yieldMiladyHttpAfterNativeMessageBoxMock: vi.fn(),
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
  confirmDesktopAction: vi.fn(),
  isCloudStatusAuthenticated: (
    connected: boolean,
    reason: string | null | undefined,
  ) =>
    connected &&
    reason !== "api_key_present_not_authenticated" &&
    reason !== "api_key_present_runtime_not_started",
  openExternalUrl: openExternalUrlMock,
  yieldMiladyHttpAfterNativeMessageBox:
    yieldMiladyHttpAfterNativeMessageBoxMock,
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
});
