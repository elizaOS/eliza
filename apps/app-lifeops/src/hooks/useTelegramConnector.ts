import type {
  LifeOpsConnectorSide,
  LifeOpsTelegramAuthState,
  LifeOpsTelegramConnectorStatus,
} from "@elizaos/shared/contracts/lifeops";
import { useCallback, useEffect, useState } from "react";
import { client } from "@elizaos/app-core/api";

function formatError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }
  return fallback;
}

export interface UseTelegramConnectorOptions {
  side?: LifeOpsConnectorSide;
}

export function useTelegramConnector(
  options: UseTelegramConnectorOptions = {},
) {
  const side = options.side ?? "owner";
  const [status, setStatus] =
    useState<LifeOpsTelegramConnectorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authState, setAuthState] = useState<LifeOpsTelegramAuthState>("idle");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextStatus = await client.getTelegramConnectorStatus(side);
      setStatus(nextStatus);
      setAuthState(nextStatus.authState);
      setError(null);
    } catch (cause) {
      setError(
        formatError(cause, "Telegram connector status failed to load."),
      );
    } finally {
      setLoading(false);
    }
  }, [side]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const nextStatus = await client.getTelegramConnectorStatus(side);
        if (cancelled) return;
        setStatus(nextStatus);
        setAuthState(nextStatus.authState);
        setError(null);
      } catch (cause) {
        if (cancelled) return;
        setError(
          formatError(cause, "Telegram connector status failed to load."),
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [side]);

  const startAuth = useCallback(
    async (phone: string) => {
      try {
        setActionPending(true);
        setError(null);
        const result = await client.startTelegramAuth({ phone, side });
        setAuthState(result.state);
        if (result.error) {
          setError(result.error);
        }
        if (result.state === "connected") {
          void refresh();
        }
      } catch (cause) {
        setError(formatError(cause, "Telegram auth failed to start."));
      } finally {
        setActionPending(false);
      }
    },
    [side, refresh],
  );

  const submitCode = useCallback(
    async (code: string) => {
      try {
        setActionPending(true);
        setError(null);
        const result = await client.submitTelegramAuth({ code, side });
        setAuthState(result.state);
        if (result.error) {
          setError(result.error);
        }
        if (result.state === "connected") {
          void refresh();
        }
      } catch (cause) {
        setError(formatError(cause, "Telegram code submission failed."));
      } finally {
        setActionPending(false);
      }
    },
    [side, refresh],
  );

  const submitPassword = useCallback(
    async (password: string) => {
      try {
        setActionPending(true);
        setError(null);
        const result = await client.submitTelegramAuth({ password, side });
        setAuthState(result.state);
        if (result.error) {
          setError(result.error);
        }
        if (result.state === "connected") {
          void refresh();
        }
      } catch (cause) {
        setError(formatError(cause, "Telegram password submission failed."));
      } finally {
        setActionPending(false);
      }
    },
    [side, refresh],
  );

  const cancelAuth = useCallback(async () => {
    try {
      setActionPending(true);
      await client.cancelTelegramAuth({ side, provider: "telegram" });
      setAuthState("idle");
      setError(null);
    } catch (cause) {
      setError(formatError(cause, "Telegram auth cancellation failed."));
    } finally {
      setActionPending(false);
    }
  }, [side]);

  const disconnect = useCallback(async () => {
    try {
      setActionPending(true);
      const nextStatus = await client.disconnectTelegramConnector({
        side,
        provider: "telegram",
      });
      setStatus(nextStatus);
      setAuthState(nextStatus.authState);
      setError(null);
    } catch (cause) {
      setError(formatError(cause, "Telegram connector disconnect failed."));
    } finally {
      setActionPending(false);
    }
  }, [side]);

  return {
    status,
    loading,
    actionPending,
    error,
    authState,
    startAuth,
    submitCode,
    submitPassword,
    cancelAuth,
    disconnect,
    refresh,
  } as const;
}
