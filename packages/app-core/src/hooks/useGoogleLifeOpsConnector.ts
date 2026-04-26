import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGoogleConnectorStatus,
} from "@elizaos/app-lifeops";
import { useCallback, useEffect, useState } from "react";
import { client } from "../api";

const DEFAULT_GOOGLE_CONNECTOR_POLL_INTERVAL_MS = 15_000;

export interface UseGoogleLifeOpsConnectorOptions {
  includeAccounts?: boolean;
  pollIntervalMs?: number;
  pollWhileDisconnected?: boolean;
  side?: LifeOpsConnectorSide;
}

function formatGoogleConnectorError(cause: unknown): string {
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message.trim()
    : "Google connector status failed to refresh.";
}

export function useGoogleLifeOpsConnector(
  options: UseGoogleLifeOpsConnectorOptions = {},
) {
  const includeAccounts = options.includeAccounts ?? false;
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_GOOGLE_CONNECTOR_POLL_INTERVAL_MS;
  const pollWhileDisconnected = options.pollWhileDisconnected ?? true;
  const side = options.side ?? "owner";
  const [status, setStatus] = useState<LifeOpsGoogleConnectorStatus | null>(
    null,
  );
  const [accounts, setAccounts] = useState<LifeOpsGoogleConnectorStatus[]>([]);
  const [selectedMode, setSelectedMode] = useState<LifeOpsConnectorMode | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async ({
      silent = false,
      mode,
    }: {
      silent?: boolean;
      mode?: LifeOpsConnectorMode | null;
    } = {}) => {
      if (!silent) {
        setLoading(true);
      }
      try {
        const requestedMode = mode === undefined ? selectedMode : mode;
        const [nextStatus, nextAccounts] = await Promise.all([
          client.getGoogleLifeOpsConnectorStatus(
            requestedMode ?? undefined,
            side,
          ),
          includeAccounts
            ? client.getGoogleLifeOpsConnectorAccounts(undefined, side)
            : Promise.resolve<LifeOpsGoogleConnectorStatus[]>([]),
        ]);
        setStatus(nextStatus);
        setAccounts(nextAccounts);
        setSelectedMode(requestedMode ?? nextStatus.mode);
        setError(null);
      } catch (cause) {
        setError(formatGoogleConnectorError(cause));
      } finally {
        setLoading(false);
      }
    },
    [includeAccounts, selectedMode, side],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (pollIntervalMs <= 0) {
      return;
    }
    if (!pollWhileDisconnected && status?.connected !== true) {
      return;
    }
    const intervalId = globalThis.setInterval(() => {
      void refresh({ silent: true });
    }, pollIntervalMs);
    return () => {
      globalThis.clearInterval(intervalId);
    };
  }, [pollIntervalMs, pollWhileDisconnected, refresh, status?.connected]);

  return {
    accounts,
    error,
    loading,
    refresh,
    selectedMode,
    side,
    status,
  } as const;
}
