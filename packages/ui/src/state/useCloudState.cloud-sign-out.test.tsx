/** Verifies useCloudState — locked Cloud account sign-out through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * Locked mobile Cloud runtime can sign out of the account without disconnecting
 * the required Cloud runtime. This is the Settings escape hatch for switching
 * accounts on mobile cloud/cloud-hybrid builds.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isAndroidCloudAccountSwitchPending,
  signOutAndroidCloud,
} from "../android-cloud/android-cloud-auth";
import { client } from "../api/client";
import { signOutFromSsoBridgedHost } from "../cloud/sso-bridge/sso-bridge";
import {
  clearPersistedActiveServer,
  loadPersistedActiveServer,
  loadPersistedFirstRunComplete,
  savePersistedActiveServer,
  savePersistedFirstRunComplete,
} from "./persistence";
import { useCloudState } from "./useCloudState";

const getCloudStatusMock = vi.hoisted(() => vi.fn());
const getCloudCreditsMock = vi.hoisted(() => vi.fn());
const cloudDisconnectMock = vi.hoisted(() => vi.fn());
const signOutFromSsoBridgedHostMock = vi.hoisted(() => vi.fn());
const signOutAndroidCloudMock = vi.hoisted(() => vi.fn());
const nativePlatformState = vi.hoisted(() => ({
  enabled: false,
  platform: "android",
}));
const revokeIosStagingMock = vi.hoisted(() => vi.fn());
const isElizaCloudRuntimeLockedMock = vi.hoisted(() => vi.fn());
const isAppModeHostMock = vi.hoisted(() => vi.fn());
const clearManagedCloudAccountBindingMock = vi.hoisted(() => vi.fn());

vi.mock("./shared-cloud-account-binding", () => ({
  clearManagedCloudAccountBinding: clearManagedCloudAccountBindingMock,
}));

vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      isNativePlatform: () => nativePlatformState.enabled,
      getPlatform: () => nativePlatformState.platform,
    },
  };
});

vi.mock("../platform/android-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform/android-runtime")>()),
  isAndroidCloudBuild: () => nativePlatformState.platform === "android",
}));

vi.mock("../ios-cloud/ios-cloud-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ios-cloud/ios-cloud-auth")>()),
  hasIosNativeCloudCredential: () => false,
  isIosNativeCloudAuthAvailable: async () => false,
  recoverIosCloudCredential: async () => "none",
  revokeIosCloudStagedCredential: revokeIosStagingMock,
}));

vi.mock("../android-cloud/android-cloud-auth", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../android-cloud/android-cloud-auth")
  >()),
  signOutAndroidCloud: signOutAndroidCloudMock,
}));

vi.mock("../api/client", () => ({
  client: {
    getBaseUrl: vi.fn(() => "https://api.eliza.app"),
    setBaseUrl: vi.fn(),
    setToken: vi.fn(),
    getCloudStatus: getCloudStatusMock,
    getCloudCredits: getCloudCreditsMock,
    cloudDisconnect: cloudDisconnectMock,
  },
}));

vi.mock("../cloud/sso-bridge/sso-bridge", () => ({
  signOutFromSsoBridgedHost: signOutFromSsoBridgedHostMock,
}));

vi.mock("../cloud/app-mode/app-mode", () => ({
  isAppModeHost: isAppModeHostMock,
}));

vi.mock("../first-run/mobile-runtime-mode", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../first-run/mobile-runtime-mode")
  >()),
  isElizaCloudRuntimeLocked: isElizaCloudRuntimeLockedMock,
}));

function makeParams() {
  return {
    setActionNotice: vi.fn(),
    loadWalletConfig: vi.fn(async () => {}),
    t: (key: string) => key,
  };
}

describe("useCloudState — Cloud account sign-out", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    getCloudStatusMock.mockResolvedValue({
      connected: true,
      enabled: true,
      userId: "user-after-poll",
    });
    getCloudCreditsMock.mockResolvedValue({
      balance: 10,
      low: false,
      critical: false,
    });
    cloudDisconnectMock.mockResolvedValue(undefined);
    signOutFromSsoBridgedHostMock.mockResolvedValue(undefined);
    signOutAndroidCloudMock.mockResolvedValue(undefined);
    clearManagedCloudAccountBindingMock.mockImplementation(async () => {
      clearPersistedActiveServer();
    });
    nativePlatformState.enabled = false;
    nativePlatformState.platform = "android";
    revokeIosStagingMock.mockReset().mockResolvedValue(undefined);
    isElizaCloudRuntimeLockedMock.mockReturnValue(true);
    isAppModeHostMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("clears the account session without calling the locked runtime disconnect path", async () => {
    nativePlatformState.enabled = true;
    savePersistedActiveServer({
      id: "cloud:previous-account-agent",
      kind: "cloud",
      label: "Previous account agent",
      apiBase: "https://previous-account-agent.cloud.eliza.app",
      accessToken: "previous-account-pair-token",
    });
    savePersistedFirstRunComplete(true);
    const params = makeParams();
    const { result } = renderHook(() => useCloudState(params));

    act(() => {
      result.current.setElizaCloudEnabled(true);
      result.current.setElizaCloudConnected(true);
      result.current.setElizaCloudUserId("user-before-sign-out");
    });

    await act(async () => {
      await result.current.handleCloudSignOut();
    });

    expect(signOutAndroidCloud).toHaveBeenCalledWith("https://eliza.app");
    expect(isAndroidCloudAccountSwitchPending()).toBe(true);
    expect(signOutFromSsoBridgedHost).not.toHaveBeenCalled();
    expect(client.cloudDisconnect).not.toHaveBeenCalled();
    expect(result.current.elizaCloudConnected).toBe(false);
    expect(result.current.elizaCloudEnabled).toBe(false);
    expect(result.current.elizaCloudUserId).toBeNull();
    expect(result.current.elizaCloudDisconnecting).toBe(false);
    expect(loadPersistedActiveServer()).toBeNull();
    expect(loadPersistedFirstRunComplete()).toBe(false);
    expect(params.setActionNotice).toHaveBeenCalledWith(
      "Signed out of Eliza Cloud.",
      "success",
      5000,
    );

    await waitFor(() => expect(client.getCloudStatus).toHaveBeenCalled());
    expect(result.current.elizaCloudConnected).toBe(false);
  });

  it("uses cross-host logout on the hosted Cloud app", async () => {
    isElizaCloudRuntimeLockedMock.mockReturnValue(false);
    isAppModeHostMock.mockReturnValue(true);
    const params = makeParams();
    const { result } = renderHook(() => useCloudState(params));

    act(() => {
      result.current.setElizaCloudEnabled(true);
      result.current.setElizaCloudConnected(true);
      result.current.setElizaCloudUserId("hosted-user-before-sign-out");
    });

    await act(async () => {
      await result.current.handleCloudSignOut();
    });

    expect(signOutFromSsoBridgedHost).toHaveBeenCalledTimes(1);
    expect(client.cloudDisconnect).not.toHaveBeenCalled();
    expect(result.current.elizaCloudConnected).toBe(false);
    expect(result.current.elizaCloudEnabled).toBe(false);
    expect(result.current.elizaCloudUserId).toBeNull();
  });

  it.each([false, true])(
    "reconciles iOS staging before SSO sign-out (revocation fails: %s)",
    async (fails) => {
      nativePlatformState.enabled = true;
      nativePlatformState.platform = "ios";
      getCloudStatusMock.mockResolvedValue({
        connected: true,
        enabled: true,
        userId: "prior-sso-user",
      });
      revokeIosStagingMock.mockImplementation(async () => {
        expect(signOutFromSsoBridgedHostMock).not.toHaveBeenCalled();
        if (fails) throw new Error("Staged revocation unavailable");
      });
      const params = makeParams();
      const { result } = renderHook(() => useCloudState(params));
      act(() => {
        result.current.setElizaCloudEnabled(true);
        result.current.setElizaCloudConnected(true);
        result.current.setElizaCloudUserId("prior-sso-user");
      });

      await act(async () => {
        if (fails) {
          await expect(result.current.handleCloudSignOut()).rejects.toThrow(
            "Staged revocation unavailable",
          );
        } else {
          await result.current.handleCloudSignOut();
        }
      });

      expect(revokeIosStagingMock).toHaveBeenCalledTimes(1);
      expect(signOutFromSsoBridgedHostMock).toHaveBeenCalledTimes(
        fails ? 0 : 1,
      );
      expect(result.current.elizaCloudConnected).toBe(fails);
      expect(result.current.elizaCloudEnabled).toBe(fails);
      expect(result.current.elizaCloudUserId).toBe(
        fails ? "prior-sso-user" : null,
      );
    },
  );
});
