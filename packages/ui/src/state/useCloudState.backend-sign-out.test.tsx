/** Verifies useCloudState — backend-backed (unlocked) Cloud account sign-out through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * On a backend-backed session (local app-core / agent runtime, runtime NOT
 * locked) the Cloud account is also persisted server-side and re-reported by
 * /api/cloud/status. Signing out there must clear the backend session, not just
 * the renderer/Steward token — otherwise the Settings affordance reports
 * success while a reload / fresh poll resurfaces the same Cloud account.
 *
 * This guards the unlocked half of the sign-out affordance: handleCloudSignOut
 * delegates to the real disconnect path (client.cloudDisconnect) when the
 * runtime is not locked. The locked mobile half is covered by
 * useCloudState.cloud-sign-out.test.tsx.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStaleStewardSession } from "../cloud/shell/StewardProviderShared";
import { useCloudState } from "./useCloudState";

const getCloudStatusMock = vi.hoisted(() => vi.fn());
const getCloudCreditsMock = vi.hoisted(() => vi.fn());
const cloudDisconnectMock = vi.hoisted(() => vi.fn());
const clearStaleStewardSessionMock = vi.hoisted(() => vi.fn());
const clearCloudPairApiTokenMock = vi.hoisted(() => vi.fn());
const clearStoredStewardTokenMock = vi.hoisted(() => vi.fn());

vi.mock("../api", () => ({
  client: {
    getBaseUrl: vi.fn(() => "https://api.elizacloud.ai"),
    getRestAuthToken: vi.fn(() => "token"),
    getCloudStatus: getCloudStatusMock,
    getCloudCredits: getCloudCreditsMock,
    cloudDisconnect: cloudDisconnectMock,
  },
}));

vi.mock("../cloud/shell/StewardProviderShared", () => ({
  clearStaleStewardSession: clearStaleStewardSessionMock,
}));

vi.mock("@elizaos/shared/steward-session-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@elizaos/shared/steward-session-client")
  >()),
  clearStoredStewardToken: clearStoredStewardTokenMock,
}));

vi.mock("./cloud-pair-token", () => ({
  clearCloudPairApiToken: clearCloudPairApiTokenMock,
  clearStalePairCredentialsForAgent: vi.fn(),
}));

vi.mock("../first-run/mobile-runtime-mode", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../first-run/mobile-runtime-mode")
  >()),
  isElizaCloudRuntimeLocked: () => false,
}));

function makeParams() {
  return {
    setActionNotice: vi.fn(),
    loadWalletConfig: vi.fn(async () => {}),
    t: (key: string) => key,
  };
}

describe("useCloudState — backend-backed (unlocked) Cloud account sign-out", () => {
  beforeEach(() => {
    getCloudStatusMock.mockResolvedValue({
      connected: false,
      enabled: false,
      userId: null,
    });
    getCloudCreditsMock.mockResolvedValue({
      balance: 10,
      low: false,
      critical: false,
    });
    cloudDisconnectMock.mockResolvedValue(undefined);
    clearStaleStewardSessionMock.mockClear();
    clearStoredStewardTokenMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("clears the backend session via the real disconnect path when runtime is not locked", async () => {
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

    // The real disconnect path was taken: backend session cleared server-side.
    expect(cloudDisconnectMock).toHaveBeenCalledTimes(1);
    // The account-only shortcut (clearStaleStewardSession) is reserved for the
    // locked runtime and must NOT be the path taken here.
    expect(clearStaleStewardSession).not.toHaveBeenCalled();
    // Disconnect clears every at-rest credential, including the durable
    // cloud-pair API token (localStorage + sessionStorage) so a rotated or
    // revoked pair key is not re-adopted at the next boot. It is called with
    // NO agent id — explicit disconnect is global intent and must clear EVERY
    // paired agent's durable key, not just the currently-active one.
    expect(clearCloudPairApiTokenMock).toHaveBeenCalledTimes(1);
    expect(clearCloudPairApiTokenMock).toHaveBeenCalledWith();
    expect(result.current.elizaCloudConnected).toBe(false);
    expect(result.current.elizaCloudEnabled).toBe(false);
    expect(result.current.elizaCloudUserId).toBeNull();
    expect(result.current.elizaCloudDisconnecting).toBe(false);
  });

  it("keeps connected logical state when protected token deletion fails", async () => {
    const deletionFailure = new Error("native secure deletion denied");
    clearStoredStewardTokenMock.mockRejectedValueOnce(deletionFailure);
    getCloudStatusMock.mockResolvedValue({
      connected: true,
      enabled: true,
      userId: "user-before-failed-sign-out",
    });
    const params = makeParams();
    const { result } = renderHook(() => useCloudState(params));

    act(() => {
      result.current.setElizaCloudEnabled(true);
      result.current.setElizaCloudConnected(true);
      result.current.setElizaCloudUserId("user-before-failed-sign-out");
    });

    await act(async () => {
      await result.current.handleCloudSignOut();
    });

    expect(clearStoredStewardTokenMock).toHaveBeenCalledTimes(1);
    expect(result.current.elizaCloudConnected).toBe(true);
    expect(result.current.elizaCloudEnabled).toBe(true);
    expect(result.current.elizaCloudUserId).toBe("user-before-failed-sign-out");
    expect(clearCloudPairApiTokenMock).not.toHaveBeenCalled();
    expect(params.setActionNotice).toHaveBeenCalledWith(
      "Failed to disconnect: native secure deletion denied",
      "error",
    );
  });
});
