// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock, reactModuleUrl } = vi.hoisted(() => {
  const disconnectedStatus = {
    provider: "signal" as const,
    side: "owner" as const,
    connected: false,
    inbound: false,
    reason: "disconnected" as const,
    identity: null,
    grantedCapabilities: [],
    pairing: null,
    grant: null,
  };
  const waitingForScanPairing = {
    sessionId: "pairing-existing",
    state: "waiting_for_scan" as const,
    qrDataUrl: "data:image/png;base64,qr",
    error: null,
  };
  const connectedPairing = {
    sessionId: "pairing-existing",
    state: "connected" as const,
    qrDataUrl: null,
    error: null,
  };
  const failedPairing = {
    sessionId: "pairing-failed",
    state: "failed" as const,
    qrDataUrl: null,
    error: "signal-cli is not installed",
  };

  return {
    clientMock: {
      getSignalConnectorStatus: vi.fn(async () => disconnectedStatus),
      startLifeOpsSignalPairing: vi.fn(async () => ({
        provider: "signal" as const,
        side: "owner" as const,
        sessionId: "pairing-new",
      })),
      getLifeOpsSignalPairingStatus: vi.fn(async () => waitingForScanPairing),
      stopLifeOpsSignalPairing: vi.fn(async () => ({
        sessionId: "pairing-existing",
        state: "idle" as const,
        qrDataUrl: null,
        error: null,
      })),
      disconnectSignalConnector: vi.fn(async () => disconnectedStatus),
      disconnectedStatus,
      waitingForScanPairing,
      connectedPairing,
      failedPairing,
    },
    reactModuleUrl: `${process.cwd()}/node_modules/react/index.js`,
  };
});

vi.mock("@elizaos/app-core/api", () => ({ client: clientMock }));
vi.mock("react", async () => import(reactModuleUrl));

import { useSignalConnector } from "./useSignalConnector";

describe("useSignalConnector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientMock.getSignalConnectorStatus.mockResolvedValue(
      clientMock.disconnectedStatus,
    );
    clientMock.startLifeOpsSignalPairing.mockResolvedValue({
      provider: "signal",
      side: "owner",
      sessionId: "pairing-new",
    });
    clientMock.getLifeOpsSignalPairingStatus.mockResolvedValue(
      clientMock.waitingForScanPairing,
    );
    clientMock.stopLifeOpsSignalPairing.mockResolvedValue({
      sessionId: "pairing-existing",
      state: "idle",
      qrDataUrl: null,
      error: null,
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("enters generating_qr immediately after pairing starts", async () => {
    const { result, unmount } = renderHook(() => useSignalConnector());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.startPairing();
    });

    expect(result.current.pairingStatus).toEqual({
      sessionId: "pairing-new",
      state: "generating_qr",
      qrDataUrl: null,
      error: null,
    });
    expect(clientMock.getLifeOpsSignalPairingStatus).not.toHaveBeenCalled();

    unmount();
  });

  it("restores the pairing session id from status so cancel works after reload", async () => {
    clientMock.getSignalConnectorStatus.mockResolvedValueOnce({
      ...clientMock.disconnectedStatus,
      pairing: clientMock.waitingForScanPairing,
    });

    const { result, unmount } = renderHook(() => useSignalConnector());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pairingStatus).toEqual(
      clientMock.waitingForScanPairing,
    );

    await act(async () => {
      await result.current.stopPairing();
    });

    expect(clientMock.stopLifeOpsSignalPairing).toHaveBeenCalledWith(
      { provider: "signal", side: "owner" },
    );
    expect(result.current.pairingStatus).toBeNull();
    unmount();
  });

  it("continues polling restored active pairing sessions", async () => {
    clientMock.getSignalConnectorStatus
      .mockResolvedValueOnce({
        ...clientMock.disconnectedStatus,
        pairing: clientMock.waitingForScanPairing,
      })
      .mockResolvedValue(clientMock.disconnectedStatus);
    clientMock.getLifeOpsSignalPairingStatus.mockResolvedValueOnce(
      clientMock.connectedPairing,
    );

    const { result, unmount } = renderHook(() => useSignalConnector());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await waitFor(
      () =>
        expect(clientMock.getLifeOpsSignalPairingStatus).toHaveBeenCalledWith(
          "pairing-existing",
        ),
      { timeout: 3_000 },
    );

    await waitFor(
      () => expect(clientMock.getSignalConnectorStatus).toHaveBeenCalledTimes(2),
      { timeout: 3_000 },
    );
    expect(result.current.pairingStatus).toBeNull();
    unmount();
  });

  it("surfaces failed pairing status errors from connector status", async () => {
    clientMock.getSignalConnectorStatus.mockResolvedValueOnce({
      ...clientMock.disconnectedStatus,
      pairing: clientMock.failedPairing,
    });

    const { result, unmount } = renderHook(() => useSignalConnector());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.pairingStatus).toEqual(clientMock.failedPairing);
    expect(result.current.error).toBe("signal-cli is not installed");
    expect(clientMock.getLifeOpsSignalPairingStatus).not.toHaveBeenCalled();
    unmount();
  });
});
