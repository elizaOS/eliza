import { client } from "@elizaos/ui";
import type {
  LifeOpsConnectorSide,
  LifeOpsTelegramAuthState,
  LifeOpsTelegramConnectorStatus,
  StartLifeOpsTelegramAuthResponse,
  VerifyLifeOpsTelegramConnectorResponse,
} from "@elizaos/shared";
import { useCallback, useEffect, useState } from "react";
import { formatConnectorError } from "./connector-error.js";

export interface UseTelegramConnectorOptions {
  side?: LifeOpsConnectorSide;
}

const TELEGRAM_PLUGIN_MANAGED_FALLBACK =
  "Telegram setup is managed by @elizaos/plugin-telegram. Configure the Telegram connector plugin in Connectors.";

type TelegramAuthResponseWithStatus = StartLifeOpsTelegramAuthResponse & {
  message?: string;
  status?: LifeOpsTelegramConnectorStatus;
};

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
  const [actionPending, setActionPending] = useState(false);
  const [verifyPending, setVerifyPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pluginManagedMessageOverride, setPluginManagedMessageOverride] =
    useState<string | null>(null);
  const [authState, setAuthState] = useState<LifeOpsTelegramAuthState>("idle");
  const [verification, setVerification] =
    useState<VerifyLifeOpsTelegramConnectorResponse | null>(null);

  const applyStatus = useCallback(
    (nextStatus: LifeOpsTelegramConnectorStatus) => {
      setStatus(nextStatus);
      setAuthState(nextStatus.authState);
      setPluginManagedMessageOverride(null);
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

  const applyAuthResult = useCallback(
    (result: TelegramAuthResponseWithStatus) => {
      if (result.status) {
        applyStatus(result.status);
      } else {
        setAuthState(result.state);
      }

      const pluginMessage = telegramPluginManagedMessage(
        result.status ?? null,
        result.error ?? result.message ?? null,
      );
      if (pluginMessage) {
        setPluginManagedMessageOverride(pluginMessage);
        setError(null);
        return;
      }

      if (result.error) {
        setError(result.error);
      }
    },
    [applyStatus],
  );

  const startAuth = useCallback(
    async (phone: string) => {
      try {
        setActionPending(true);
        setError(null);
        const result = (await client.startTelegramAuth({
          phone,
          side,
        })) as TelegramAuthResponseWithStatus;
        applyAuthResult(result);
        void refresh();
      } catch (cause) {
        const message = formatConnectorError(
          cause,
          "Telegram auth failed to start.",
        );
        if (isTelegramPluginManagedMessage(message)) {
          setPluginManagedMessageOverride(message);
          setError(null);
        } else {
          setError(message);
        }
      } finally {
        setActionPending(false);
      }
    },
    [side, refresh, applyAuthResult],
  );

  const submitCode = useCallback(
    async (code: string) => {
      try {
        setActionPending(true);
        setError(null);
        const result = (await client.submitTelegramAuth({
          code,
          side,
        })) as TelegramAuthResponseWithStatus;
        applyAuthResult(result);
        void refresh();
      } catch (cause) {
        const message = formatConnectorError(
          cause,
          "Telegram code submission failed.",
        );
        if (isTelegramPluginManagedMessage(message)) {
          setPluginManagedMessageOverride(message);
          setError(null);
        } else {
          setError(message);
        }
      } finally {
        setActionPending(false);
      }
    },
    [side, refresh, applyAuthResult],
  );

  const submitPassword = useCallback(
    async (password: string) => {
      try {
        setActionPending(true);
        setError(null);
        const result = (await client.submitTelegramAuth({
          password,
          side,
        })) as TelegramAuthResponseWithStatus;
        applyAuthResult(result);
        void refresh();
      } catch (cause) {
        const message = formatConnectorError(
          cause,
          "Telegram password submission failed.",
        );
        if (isTelegramPluginManagedMessage(message)) {
          setPluginManagedMessageOverride(message);
          setError(null);
        } else {
          setError(message);
        }
      } finally {
        setActionPending(false);
      }
    },
    [side, refresh, applyAuthResult],
  );

  const cancelAuth = useCallback(async () => {
    try {
      setActionPending(true);
      await client.cancelTelegramAuth({ side, provider: "telegram" });
      setError(null);
      setPluginManagedMessageOverride(null);
      setVerification(null);
      void refresh();
    } catch (cause) {
      setError(
        formatConnectorError(cause, "Telegram auth cancellation failed."),
      );
    } finally {
      setActionPending(false);
    }
  }, [side, refresh]);

  const disconnect = useCallback(async () => {
    try {
      setActionPending(true);
      const nextStatus = await client.disconnectTelegramConnector({
        side,
        provider: "telegram",
      });
      applyStatus(nextStatus);
      setVerification(null);
    } catch (cause) {
      setError(
        formatConnectorError(cause, "Telegram connector disconnect failed."),
      );
    } finally {
      setActionPending(false);
    }
  }, [side, applyStatus]);

  const verify = useCallback(async () => {
    try {
      setVerifyPending(true);
      setError(null);
      const result = await client.verifyTelegramConnector({ side });
      setVerification(result);
    } catch (cause) {
      setError(formatConnectorError(cause, "Telegram verification failed."));
    } finally {
      setVerifyPending(false);
    }
  }, [side]);

  const pluginManagedMessage = telegramPluginManagedMessage(
    status,
    pluginManagedMessageOverride,
  );

  return {
    status,
    loading,
    actionPending,
    verifyPending,
    error,
    authState,
    verification,
    setupManagedByPlugin: true,
    pluginManaged: Boolean(pluginManagedMessage),
    pluginManagedMessage:
      pluginManagedMessage ?? TELEGRAM_PLUGIN_MANAGED_FALLBACK,
    startAuth,
    submitCode,
    submitPassword,
    cancelAuth,
    disconnect,
    verify,
    refresh,
  } as const;
}
