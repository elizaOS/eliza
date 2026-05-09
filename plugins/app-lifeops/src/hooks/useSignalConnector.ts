import { client } from "@elizaos/app-core";
import type {
  LifeOpsConnectorSide,
  LifeOpsSignalConnectorStatus,
  LifeOpsSignalPairingStatus,
  StartLifeOpsSignalPairingResponse,
} from "@elizaos/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatConnectorError } from "./connector-error.js";

const PAIRING_POLL_INTERVAL_MS = 2_000;
const SIGNAL_PLUGIN_MANAGED_FALLBACK =
  "Signal setup is managed by @elizaos/plugin-signal. Configure the Signal connector plugin in Connectors.";

type SignalPairingStartResponseWithStatus =
  StartLifeOpsSignalPairingResponse & {
    error?: string;
    message?: string;
    status?: LifeOpsSignalConnectorStatus;
  };

type SignalPairingStatusWithStatus = LifeOpsSignalPairingStatus & {
  status?: LifeOpsSignalConnectorStatus;
};

function isSignalPluginManagedMessage(
  message: string | null | undefined,
): boolean {
  const normalized = message?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("@elizaos/plugin-signal") ||
    normalized.includes("signal pairing is managed") ||
    normalized.includes("signal setup is managed") ||
    normalized.includes("signal pairing has moved")
  );
}

function signalPluginManagedMessage(
  status: LifeOpsSignalConnectorStatus | null,
  fallback: string | null,
): string | null {
  const degradation = status?.degradations?.find(
    (item) =>
      item.code.startsWith("signal_plugin") ||
      isSignalPluginManagedMessage(item.message),
  );
  if (degradation) {
    return degradation.message;
  }
  if (isSignalPluginManagedMessage(fallback)) {
    return fallback;
  }
  return null;
}

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
  const [pluginManagedMessageOverride, setPluginManagedMessageOverride] =
    useState<string | null>(null);
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

  const applyStatus = useCallback(
    (nextStatus: LifeOpsSignalConnectorStatus) => {
      setStatus(nextStatus);
      syncPairingState(nextStatus.pairing);
      setPluginManagedMessageOverride(null);
      setError(pairingStatusError(nextStatus.pairing));
    },
    [syncPairingState],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextStatus = await client.getSignalConnectorStatus(side);
      applyStatus(nextStatus);
    } catch (cause) {
      setError(
        formatConnectorError(cause, "Signal connector status failed to load."),
      );
    } finally {
      setLoading(false);
    }
  }, [side, applyStatus]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const nextStatus = await client.getSignalConnectorStatus(side);
        if (cancelled) return;
        applyStatus(nextStatus);
      } catch (cause) {
        if (cancelled) return;
        setError(
          formatConnectorError(
            cause,
            "Signal connector status failed to load.",
          ),
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [side, applyStatus]);

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
        const nextPairing = (await client.getLifeOpsSignalPairingStatus(
          activePairingSessionId,
        )) as SignalPairingStatusWithStatus;
        if (nextPairing.status) {
          setStatus(nextPairing.status);
        }
        const pluginMessage = signalPluginManagedMessage(
          nextPairing.status ?? null,
          nextPairing.error,
        );
        if (pluginMessage) {
          setPluginManagedMessageOverride(pluginMessage);
          pairingSessionIdRef.current = null;
          setPairingStatus(null);
          setError(null);
          clearPairingPoll();
          void refresh();
          return;
        }
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
        setError(
          formatConnectorError(cause, "Signal pairing status poll failed."),
        );
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
      const result = (await client.startLifeOpsSignalPairing({
        side,
      })) as SignalPairingStartResponseWithStatus;
      if (result.status) {
        applyStatus(result.status);
      }
      const pluginMessage = signalPluginManagedMessage(
        result.status ?? null,
        result.error ?? result.message ?? null,
      );
      if (pluginMessage || result.sessionId.startsWith("plugin-managed:")) {
        setPluginManagedMessageOverride(
          pluginMessage ?? SIGNAL_PLUGIN_MANAGED_FALLBACK,
        );
        pairingSessionIdRef.current = null;
        setPairingStatus(null);
        setError(null);
        return null;
      }
      pairingSessionIdRef.current = result.sessionId;
      setPairingStatus({
        sessionId: result.sessionId,
        state: "generating_qr",
        qrDataUrl: null,
        error: null,
      });
      return result.sessionId;
    } catch (cause) {
      const message = formatConnectorError(
        cause,
        "Signal pairing failed to start.",
      );
      if (isSignalPluginManagedMessage(message)) {
        setPluginManagedMessageOverride(message);
        setError(null);
      } else {
        setError(message);
      }
      return null;
    } finally {
      setActionPending(false);
    }
  }, [side, applyStatus]);

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
      setPluginManagedMessageOverride(null);
    } catch (cause) {
      setError(formatConnectorError(cause, "Signal pairing failed to stop."));
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
      applyStatus(nextStatus);
    } catch (cause) {
      setError(
        formatConnectorError(cause, "Signal connector disconnect failed."),
      );
    } finally {
      setActionPending(false);
    }
  }, [side, clearPairingPoll, applyStatus]);

  const pluginManagedMessage = signalPluginManagedMessage(
    status,
    pluginManagedMessageOverride,
  );

  return {
    status,
    loading,
    actionPending,
    error,
    pairingStatus,
    setupManagedByPlugin: true,
    pluginManaged: Boolean(pluginManagedMessage),
    pluginManagedMessage:
      pluginManagedMessage ?? SIGNAL_PLUGIN_MANAGED_FALLBACK,
    startPairing,
    stopPairing,
    disconnect,
    refresh,
  } as const;
}
