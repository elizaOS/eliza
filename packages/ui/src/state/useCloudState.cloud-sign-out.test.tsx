/** Verifies useCloudState — locked Cloud account sign-out through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * Locked mobile Cloud runtime can sign out of the account without disconnecting
 * the required Cloud runtime. This is the Settings escape hatch for switching
 * accounts on mobile cloud/cloud-hybrid builds.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../api";
import { clearStaleStewardSession } from "../cloud/shell/StewardProviderShared";
import { useCloudState } from "./useCloudState";

const getCloudStatusMock = vi.hoisted(() => vi.fn());
const getCloudCreditsMock = vi.hoisted(() => vi.fn());
const cloudDisconnectMock = vi.hoisted(() => vi.fn());
const clearStaleStewardSessionMock = vi.hoisted(() => vi.fn());

vi.mock("../api", () => ({
  client: {
    getBaseUrl: vi.fn(() => "https://api.elizacloud.ai"),
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
  isElizaCloudRuntimeLocked: () => true,
}));

function makeParams() {
  return {
    setActionNotice: vi.fn(),
    loadWalletConfig: vi.fn(async () => {}),
    t: (key: string) => key,
  };
}

describe("useCloudState — locked Cloud account sign-out", () => {
  beforeEach(() => {
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
    clearStaleStewardSessionMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("clears the account session without calling the locked runtime disconnect path", async () => {
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

    expect(clearStaleStewardSession).toHaveBeenCalledTimes(1);
    expect(client.cloudDisconnect).not.toHaveBeenCalled();
    expect(result.current.elizaCloudConnected).toBe(false);
    expect(result.current.elizaCloudEnabled).toBe(false);
    expect(result.current.elizaCloudUserId).toBeNull();
    expect(result.current.elizaCloudDisconnecting).toBe(false);
    expect(params.setActionNotice).toHaveBeenCalledWith(
      "Signed out of Eliza Cloud.",
      "success",
      5000,
    );

    await waitFor(() => expect(client.getCloudStatus).toHaveBeenCalled());
    expect(result.current.elizaCloudConnected).toBe(false);
  });
});
