import type {
  LifeOpsConnectorSide,
  LifeOpsSignalConnectorStatus,
} from "@elizaos/shared";
import { client } from "@elizaos/ui";
import { useCallback, useEffect, useState } from "react";
import { formatConnectorError } from "./connector-error.js";

const SIGNAL_PLUGIN_MANAGED_FALLBACK =
  "Signal setup is managed by @elizaos/plugin-signal. Configure the Signal connector plugin in Connectors.";

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

export interface UseSignalConnectorOptions {
  side?: LifeOpsConnectorSide;
}

export function useSignalConnector(options: UseSignalConnectorOptions = {}) {
  const side = options.side ?? "owner";
  const [status, setStatus] = useState<LifeOpsSignalConnectorStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const applyStatus = useCallback(
    (nextStatus: LifeOpsSignalConnectorStatus) => {
      setStatus(nextStatus);
      setError(null);
    },
    [],
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

  const pluginManagedMessage = signalPluginManagedMessage(status, null);

  return {
    status,
    loading,
    error,
    setupManagedByPlugin: true,
    pluginManaged: Boolean(pluginManagedMessage),
    pluginManagedMessage:
      pluginManagedMessage ?? SIGNAL_PLUGIN_MANAGED_FALLBACK,
    refresh,
  } as const;
}
