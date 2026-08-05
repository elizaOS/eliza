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
    expect(result.current.elizaCloudConnected).toBe(false);
    expect(result.current.elizaCloudEnabled).toBe(false);
    expect(result.current.elizaCloudUserId).toBeNull();
    expect(result.current.elizaCloudDisconnecting).toBe(false);
  });
});
