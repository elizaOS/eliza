/**
 * React hook exposing the Telegram LifeOps connector status (owner or agent
 * side) and its connect/disconnect controls. The Telegram transport client
 * lives in `@elizaos/plugin-telegram`; this hook reads and toggles the
 * normalized connector status for the UI.
 */
import type {
  LifeOpsConnectorSide,
  LifeOpsTelegramConnectorStatus,
} from "@elizaos/shared";
import { client } from "@elizaos/ui";
import { useCallback, useEffect, useState } from "react";
import { formatConnectorError } from "./connector-error.js";

export interface UseTelegramConnectorOptions {
  side?: LifeOpsConnectorSide;
}

const TELEGRAM_PLUGIN_MANAGED_FALLBACK =
  "Telegram setup is managed by @elizaos/plugin-telegram. Configure the Telegram connector plugin in Connectors.";

function isTelegramPluginManagedMessage(
  message: string | null | undefined,
): boolean {
  const normalized = message?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("@elizaos/plugin-telegram") ||
    normalized.includes("telegram setup is managed") ||
    normalized.includes("telegram account auth has moved") ||
    normalized.includes("lifeops code/password submission is disabled")
  );
}

function telegramPluginManagedMessage(
  status: LifeOpsTelegramConnectorStatus | null,
  fallback: string | null,
): string | null {
  const degradation = status?.degradations?.find(
    (item) =>
      item.code.startsWith("telegram_plugin") ||
      isTelegramPluginManagedMessage(item.message),
  );
  if (degradation) {
    return degradation.message;
  }
  if (isTelegramPluginManagedMessage(status?.authError)) {
    return status?.authError ?? TELEGRAM_PLUGIN_MANAGED_FALLBACK;
  }
  if (isTelegramPluginManagedMessage(fallback)) {
    return fallback;
  }
  return null;
}

export function useTelegramConnector(
  options: UseTelegramConnectorOptions = {},
) {
  const side = options.side ?? "owner";
  const [status, setStatus] = useState<LifeOpsTelegramConnectorStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const applyStatus = useCallback(
    (nextStatus: LifeOpsTelegramConnectorStatus) => {
      setStatus(nextStatus);
      setError(
        isTelegramPluginManagedMessage(nextStatus.authError)
          ? null
          : (nextStatus.authError ?? null),
      );
    },
    [],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextStatus = await client.getTelegramConnectorStatus(side);
      applyStatus(nextStatus);
    } catch (cause) {
      setError(
        formatConnectorError(
          cause,
          "Telegram connector status failed to load.",
        ),
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
        const nextStatus = await client.getTelegramConnectorStatus(side);
        if (cancelled) return;
        applyStatus(nextStatus);
      } catch (cause) {
        if (cancelled) return;
        setError(
          formatConnectorError(
            cause,
            "Telegram connector status failed to load.",
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

  const pluginManagedMessage = telegramPluginManagedMessage(status, null);

  return {
    status,
    loading,
    error,
    setupManagedByPlugin: true,
    pluginManaged: Boolean(pluginManagedMessage),
    pluginManagedMessage:
      pluginManagedMessage ?? TELEGRAM_PLUGIN_MANAGED_FALLBACK,
    refresh,
  } as const;
}
