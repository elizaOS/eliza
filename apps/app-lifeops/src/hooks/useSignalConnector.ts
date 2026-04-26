import { client } from "@elizaos/app-core";
import type {
  LifeOpsConnectorSide,
  LifeOpsSignalConnectorStatus,
  LifeOpsSignalPairingStatus,
} from "@elizaos/shared";
import { useCallback, useEffect, useRef, useState } from "react";

const PAIRING_POLL_INTERVAL_MS = 2_000;

function isActivePairingState(
  state: LifeOpsSignalPairingStatus["state"],
): boolean {
  return (
    state === "generating_qr" ||
    state === "waiting_for_scan" ||
    state === "linking"
  );
}

function pairingStatusError(
  pairing: LifeOpsSignalPairingStatus | null,
): string | null {
  if (pairing?.state !== "failed") {
    return null;
  }
  return pairing.error ?? "Signal pairing failed.";
}

function formatError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }
  return fallback;
}

export interface UseSignalConnectorOptions {
  side?: LifeOpsConnectorSide;
}

export function useSignalConnector(options: UseSignalConnectorOptions = {}) {
  const side = options.side ?? "owner";
  const [status, setStatus] = useState<LifeOpsSignalConnectorStatus | null>(
    null,
  );
  const [pairingStatus, setPairingStatus] =
    useState<LifeOpsSignalPairingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pairingSessionIdRef = useRef<string | null>(null);
  const pairingPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pairingPollSessionIdRef = useRef<string | null>(null);

  const clearPairingPoll = useCallback(() => {
    if (pairingPollRef.current !== null) {
      clearInterval(pairingPollRef.current);
      pairingPollRef.current = null;
    }
    pairingPollSessionIdRef.current = null;
  }, []);

  const syncPairingState = useCallback(
    (nextPairing: LifeOpsSignalPairingStatus | null) => {
      pairingSessionIdRef.current = nextPairing?.sessionId ?? null;
      setPairingStatus(nextPairing);
    },
    [],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextStatus = await client.getSignalConnectorStatus(side);
      setStatus(nextStatus);
      syncPairingState(nextStatus.pairing);
      setError(pairingStatusError(nextStatus.pairing));
    } catch (cause) {
      setError(formatError(cause, "Signal connector status failed to load."));
    } finally {
      setLoading(false);
    }
  }, [side, syncPairingState]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const nextStatus = await client.getSignalConnectorStatus(side);
        if (cancelled) return;
        setStatus(nextStatus);
        syncPairingState(nextStatus.pairing);
        setError(pairingStatusError(nextStatus.pairing));
      } catch (cause) {
        if (cancelled) return;
        setError(formatError(cause, "Signal connector status failed to load."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [side, syncPairingState]);

  useEffect(() => {
    return () => {
      clearPairingPoll();
    };
  }, [clearPairingPoll]);

  const activePairingSessionId =
    pairingStatus !== null && isActivePairingState(pairingStatus.state)
      ? pairingStatus.sessionId
      : null;

  useEffect(() => {
    if (!activePairingSessionId) {
      clearPairingPoll();
      return;
    }

    if (pairingPollSessionIdRef.current === activePairingSessionId) {
      return;
    }

    clearPairingPoll();
    pairingPollSessionIdRef.current = activePairingSessionId;
    pairingPollRef.current = setInterval(async () => {
      try {
        const nextPairing =
          await client.getLifeOpsSignalPairingStatus(activePairingSessionId);
        setPairingStatus(nextPairing);
        setError(pairingStatusError(nextPairing));
        if (!isActivePairingState(nextPairing.state)) {
          pairingSessionIdRef.current = null;
          clearPairingPoll();
          if (
            nextPairing.state === "connected" ||
            nextPairing.state === "failed"
          ) {
            void refresh();
          }
        }
      } catch (cause) {
        setError(formatError(cause, "Signal pairing status poll failed."));
      }
    }, PAIRING_POLL_INTERVAL_MS);

    return () => {
      if (pairingPollSessionIdRef.current === activePairingSessionId) {
        clearPairingPoll();
      }
    };
  }, [activePairingSessionId, clearPairingPoll, refresh]);

  const startPairing = useCallback(async () => {
    try {
      setActionPending(true);
      setError(null);
      const result = await client.startLifeOpsSignalPairing({ side });
      pairingSessionIdRef.current = result.sessionId;
      setPairingStatus({
        sessionId: result.sessionId,
        state: "generating_qr",
        qrDataUrl: null,
        error: null,
      });
      return result.sessionId;
    } catch (cause) {
      setError(formatError(cause, "Signal pairing failed to start."));
      return null;
    } finally {
      setActionPending(false);
    }
  }, [side]);

  const stopPairing = useCallback(async () => {
    const sessionId = pairingSessionIdRef.current;
    if (!sessionId) return;
    try {
      setActionPending(true);
      clearPairingPoll();
      await client.stopLifeOpsSignalPairing({ side, provider: "signal" });
      pairingSessionIdRef.current = null;
      setPairingStatus(null);
      setError(null);
    } catch (cause) {
      setError(formatError(cause, "Signal pairing failed to stop."));
    } finally {
      setActionPending(false);
    }
  }, [side, clearPairingPoll]);

  const disconnect = useCallback(async () => {
    try {
      setActionPending(true);
      clearPairingPoll();
      pairingSessionIdRef.current = null;
      setPairingStatus(null);
      const nextStatus = await client.disconnectSignalConnector({
        side,
        provider: "signal",
      });
      setStatus(nextStatus);
      syncPairingState(nextStatus.pairing);
      setError(pairingStatusError(nextStatus.pairing));
    } catch (cause) {
      setError(formatError(cause, "Signal connector disconnect failed."));
    } finally {
      setActionPending(false);
    }
  }, [side, clearPairingPoll, syncPairingState]);

  return {
    status,
    loading,
    actionPending,
    error,
    pairingStatus,
    startPairing,
    stopPairing,
    disconnect,
    refresh,
  } as const;
}
