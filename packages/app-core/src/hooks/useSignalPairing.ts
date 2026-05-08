import { useCallback, useEffect, useState } from "react";
import { client } from "../api/client";
import { DEFAULT_CONNECTOR_ACCOUNT_ID } from "./useConnectorAccounts";

export type { SignalPairingStatus } from "@elizaos/agent";

import type { SignalPairingStatus } from "@elizaos/agent";

interface SignalPairingState {
  status: SignalPairingStatus;
  qrDataUrl: string | null;
  phoneNumber: string | null;
  error: string | null;
}

type SignalStatusResponse = Awaited<ReturnType<typeof client.getSignalStatus>>;

const IDLE_SIGNAL_PAIRING_STATE: SignalPairingState = {
  status: "idle",
  qrDataUrl: null,
  phoneNumber: null,
  error: null,
};

function stateFromStatusResponse(
  response: SignalStatusResponse,
): SignalPairingState {
  return {
    status: response.status as SignalPairingStatus,
    qrDataUrl: response.qrDataUrl,
    phoneNumber: response.phoneNumber,
    error: response.error,
  };
}

function toSignalPairingErrorState(error: unknown): SignalPairingState {
  return {
    ...IDLE_SIGNAL_PAIRING_STATE,
    status: "error",
    error: error instanceof Error ? error.message : String(error),
  };
}

export function useSignalPairing(accountId = DEFAULT_CONNECTOR_ACCOUNT_ID) {
  const [state, setState] = useState<SignalPairingState>(
    IDLE_SIGNAL_PAIRING_STATE,
  );

  useEffect(() => {
    let cancelled = false;

    void client
      .getSignalStatus(accountId)
      .then((response) => {
        if (cancelled) {
          return;
        }
        setState(stateFromStatusResponse(response));
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setState(toSignalPairingErrorState(error));
      });

    return () => {
      cancelled = true;
    };
  }, [accountId]);

  useEffect(() => {
    const unbindQr = client.onWsEvent(
      "signal-qr",
      (data: Record<string, unknown>) => {
        if (data.accountId !== accountId) return;
        setState((prev) => ({
          ...prev,
          status: "waiting_for_qr",
          qrDataUrl: (data.qrDataUrl as string) ?? null,
          error: null,
        }));
      },
    );

    const unbindStatus = client.onWsEvent(
      "signal-status",
      (data: Record<string, unknown>) => {
        if (data.accountId !== accountId) return;
        const nextStatus = data.status as SignalPairingStatus;
        const clearQrDataUrl =
          nextStatus === "connected" ||
          nextStatus === "disconnected" ||
          nextStatus === "timeout" ||
          nextStatus === "error";
        setState((prev) => ({
          ...prev,
          status: nextStatus,
          phoneNumber: (data.phoneNumber as string) ?? prev.phoneNumber,
          error: (data.error as string) ?? null,
          qrDataUrl: clearQrDataUrl ? null : prev.qrDataUrl,
        }));
      },
    );

    return () => {
      unbindQr();
      unbindStatus();
    };
  }, [accountId]);

  const startPairing = useCallback(async () => {
    setState({
      status: "initializing",
      qrDataUrl: null,
      phoneNumber: null,
      error: null,
    });

    try {
      const result = await client.startSignalPairing(accountId);
      if (result.ok) {
        setState((prev) => ({
          ...prev,
          status: result.status as SignalPairingStatus,
          error: null,
        }));
      } else {
        setState((prev) => ({
          ...prev,
          status: "error",
          error: result.error ?? "Failed to start Signal pairing",
        }));
      }
    } catch (error) {
      setState((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [accountId]);

  const stopPairing = useCallback(async () => {
    try {
      await client.stopSignalPairing(accountId);
      setState(IDLE_SIGNAL_PAIRING_STATE);
    } catch (error) {
      setState(toSignalPairingErrorState(error));
    }
  }, [accountId]);

  const disconnect = useCallback(async () => {
    try {
      await client.disconnectSignal(accountId);
      setState(IDLE_SIGNAL_PAIRING_STATE);
    } catch (error) {
      setState(toSignalPairingErrorState(error));
    }
  }, [accountId]);

  return { ...state, startPairing, stopPairing, disconnect };
}
