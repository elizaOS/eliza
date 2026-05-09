import { client } from "@elizaos/app-core";
import { openExternalUrl } from "@elizaos/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsHealthConnectorProvider,
  LifeOpsHealthConnectorStatus,
  LifeOpsHealthSummaryResponse,
} from "../contracts/index.js";
import { LIFEOPS_HEALTH_CONNECTOR_PROVIDERS } from "../contracts/index.js";
import { formatConnectorError } from "./connector-error.js";

type ProviderMap<T> = Partial<Record<LifeOpsHealthConnectorProvider, T>>;

function providerStatusMap(
  statuses: readonly LifeOpsHealthConnectorStatus[],
): ProviderMap<LifeOpsHealthConnectorStatus> {
  return statuses.reduce<ProviderMap<LifeOpsHealthConnectorStatus>>(
    (acc, status) => {
      acc[status.provider] = status;
      return acc;
    },
    {},
  );
}

function providerErrorMap(message: string): ProviderMap<string> {
  return LIFEOPS_HEALTH_CONNECTOR_PROVIDERS.reduce<ProviderMap<string>>(
    (acc, provider) => {
      acc[provider] = message;
      return acc;
    },
    {},
  );
}

export function useLifeOpsHealthConnectors(
  side: LifeOpsConnectorSide = "owner",
) {
  const [statuses, setStatuses] = useState<LifeOpsHealthConnectorStatus[]>([]);
  const [summary, setSummary] = useState<LifeOpsHealthSummaryResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionPendingProvider, setActionPendingProvider] =
    useState<LifeOpsHealthConnectorProvider | null>(null);
  const [syncPendingProvider, setSyncPendingProvider] =
    useState<LifeOpsHealthConnectorProvider | null>(null);
  const [errorByProvider, setErrorByProvider] = useState<
    ProviderMap<string | null>
  >({});
  const [pendingAuthUrlByProvider, setPendingAuthUrlByProvider] = useState<
    ProviderMap<string | null>
  >({});

  const statusesByProvider = useMemo(
    () => providerStatusMap(statuses),
    [statuses],
  );

  const setProviderError = useCallback(
    (provider: LifeOpsHealthConnectorProvider, error: string | null) => {
      setErrorByProvider((current) => ({ ...current, [provider]: error }));
    },
    [],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const nextStatuses = await client.getHealthLifeOpsConnectorStatuses(
        undefined,
        side,
      );
      setStatuses(nextStatuses);
      setErrorByProvider({});
      setPendingAuthUrlByProvider((current) => {
        const next = { ...current };
        for (const status of nextStatuses) {
          if (status.connected) {
            next[status.provider] = null;
          }
        }
        return next;
      });
    } catch (cause) {
      const message = formatConnectorError(
        cause,
        "Health connector status failed to load.",
      );
      setErrorByProvider(providerErrorMap(message));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [side]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const nextStatuses = await client.getHealthLifeOpsConnectorStatuses(
          undefined,
          side,
        );
        if (!cancelled) {
          setStatuses(nextStatuses);
          setErrorByProvider({});
        }
      } catch (cause) {
        if (!cancelled) {
          const message = formatConnectorError(
            cause,
            "Health connector status failed to load.",
          );
          setErrorByProvider(providerErrorMap(message));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [side]);

  useEffect(() => {
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  const connect = useCallback(
    async (
      provider: LifeOpsHealthConnectorProvider,
      mode?: LifeOpsConnectorMode,
    ) => {
      try {
        setActionPendingProvider(provider);
        setProviderError(provider, null);
        setPendingAuthUrlByProvider((current) => ({
          ...current,
          [provider]: null,
        }));
        const currentStatus = statusesByProvider[provider];
        const result = await client.startHealthLifeOpsConnector(provider, {
          side,
          mode: mode ?? currentStatus?.mode ?? currentStatus?.defaultMode,
        });
        if (result.authUrl) {
          setPendingAuthUrlByProvider((current) => ({
            ...current,
            [provider]: result.authUrl,
          }));
          await openExternalUrl(result.authUrl);
        } else {
          await refresh();
        }
      } catch (cause) {
        setProviderError(
          provider,
          formatConnectorError(cause, `${provider} connector connect failed.`),
        );
      } finally {
        setActionPendingProvider(null);
      }
    },
    [refresh, setProviderError, side, statusesByProvider],
  );

  const disconnect = useCallback(
    async (provider: LifeOpsHealthConnectorProvider) => {
      const currentStatus = statusesByProvider[provider];
      try {
        setActionPendingProvider(provider);
        setProviderError(provider, null);
        await client.disconnectHealthLifeOpsConnector(provider, {
          side,
          mode: currentStatus?.mode,
          grantId: currentStatus?.grant?.id,
        });
        setPendingAuthUrlByProvider((current) => ({
          ...current,
          [provider]: null,
        }));
        await refresh();
      } catch (cause) {
        setProviderError(
          provider,
          formatConnectorError(
            cause,
            `${provider} connector disconnect failed.`,
          ),
        );
      } finally {
        setActionPendingProvider(null);
      }
    },
    [refresh, setProviderError, side, statusesByProvider],
  );

  const sync = useCallback(
    async (provider?: LifeOpsHealthConnectorProvider) => {
      try {
        setSyncPendingProvider(provider ?? null);
        if (provider) {
          setProviderError(provider, null);
        }
        const nextSummary = await client.syncLifeOpsHealth({
          provider,
          side,
          days: 14,
        });
        setSummary(nextSummary);
        setStatuses(nextSummary.providers);
      } catch (cause) {
        const message = formatConnectorError(
          cause,
          "Health connector sync failed.",
        );
        if (provider) {
          setProviderError(provider, message);
        } else {
          setErrorByProvider(providerErrorMap(message));
        }
      } finally {
        setSyncPendingProvider(null);
      }
    },
    [setProviderError, side],
  );

  return {
    providers: LIFEOPS_HEALTH_CONNECTOR_PROVIDERS,
    statuses,
    statusesByProvider,
    summary,
    loading,
    refreshing,
    actionPendingProvider,
    syncPendingProvider,
    errorByProvider,
    pendingAuthUrlByProvider,
    refresh,
    connect,
    disconnect,
    sync,
  } as const;
}
