import type {
  LifeOpsConnectorSide,
  LifeOpsSignalConnectorStatus,
  LifeOpsSignalPairingStatus,
} from "@elizaos/shared/contracts/lifeops";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "@elizaos/app-core/api";

const PAIRING_POLL_INTERVAL_MS = 2_000;

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

  const clearPairingPoll = useCallback(() => {
    if (pairingPollRef.current !== null) {
      clearInterval(pairingPollRef.current);
      pairingPollRef.current = null;
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextStatus = await client.getSignalConnectorStatus(side);
      setStatus(nextStatus);
      if (nextStatus.pairing) {
        setPairingStatus(nextStatus.pairing);
      }
      setError(null);
    } catch (cause) {
      setError(formatError(cause, "Signal connector status failed to load."));
    } finally {
      setLoading(false);
    }
  }, [side]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const nextStatus = await client.getSignalConnectorStatus(side);
        if (cancelled) return;
        setStatus(nextStatus);
        if (nextStatus.pairing) {
          setPairingStatus(nextStatus.pairing);
        }
        setError(null);
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
  }, [side]);

  useEffect(() => {
    return () => {
      clearPairingPoll();
    };
  }, [clearPairingPoll]);

  const pollPairingStatus = useCallback(
    (sessionId: string) => {
      clearPairingPoll();
      pairingPollRef.current = setInterval(async () => {
        try {
          const ps = await client.getLifeOpsSignalPairingStatus(sessionId);
          setPairingStatus(ps);
          if (ps.state === "connected" || ps.state === "failed") {
            clearPairingPoll();
            pairingSessionIdRef.current = null;
            void refresh();
          }
        } catch (cause) {
          // Keep polling across transient failures; log so a broken backend
          // surfaces in the browser console instead of a silent stall.
          console.warn(
            "[useSignalConnector] pairing status poll failed",
            cause,
          );
        }
      }, PAIRING_POLL_INTERVAL_MS);
    },
    [clearPairingPoll, refresh],
  );

  const startPairing = useCallback(async () => {
    try {
      setActionPending(true);
      setError(null);
      const result = await client.startLifeOpsSignalPairing({ side });
      pairingSessionIdRef.current = result.sessionId;
      pollPairingStatus(result.sessionId);
      return result.sessionId;
    } catch (cause) {
      setError(formatError(cause, "Signal pairing failed to start."));
      return null;
    } finally {
      setActionPending(false);
    }
  }, [side, pollPairingStatus]);

  const stopPairing = useCallback(async () => {
    const sessionId = pairingSessionIdRef.current;
    if (!sessionId) return;
    try {
      setActionPending(true);
      clearPairingPoll();
      await client.stopLifeOpsSignalPairing(sessionId);
      pairingSessionIdRef.current = null;
      setPairingStatus(null);
      setError(null);
    } catch (cause) {
      setError(formatError(cause, "Signal pairing failed to stop."));
    } finally {
      setActionPending(false);
    }
  }, [clearPairingPoll]);

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
      setError(null);
    } catch (cause) {
      setError(formatError(cause, "Signal connector disconnect failed."));
    } finally {
      setActionPending(false);
    }
  }, [side, clearPairingPoll]);

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
