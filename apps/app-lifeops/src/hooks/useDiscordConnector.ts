import type {
  LifeOpsConnectorSide,
  LifeOpsDiscordConnectorStatus,
} from "@elizaos/shared/contracts/lifeops";
import { useCallback, useEffect, useState } from "react";
import { client } from "@elizaos/app-core/api";
import { openExternalUrl } from "@elizaos/app-core/utils";

function formatError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }
  return fallback;
}

export interface UseDiscordConnectorOptions {
  side?: LifeOpsConnectorSide;
}

export function useDiscordConnector(options: UseDiscordConnectorOptions = {}) {
  const side = options.side ?? "owner";
  const [status, setStatus] = useState<LifeOpsDiscordConnectorStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextStatus = await client.getDiscordConnectorStatus(side);
      setStatus(nextStatus);
      setError(null);
    } catch (cause) {
      setError(formatError(cause, "Discord connector status failed to load."));
    } finally {
      setLoading(false);
    }
  }, [side]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const nextStatus = await client.getDiscordConnectorStatus(side);
        if (cancelled) return;
        setStatus(nextStatus);
        setError(null);
      } catch (cause) {
        if (cancelled) return;
        setError(
          formatError(cause, "Discord connector status failed to load."),
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [side]);

  const connect = useCallback(
    async (redirectUrl?: string) => {
      try {
        setActionPending(true);
        setError(null);
        const result = await client.startDiscordConnector({
          side,
          redirectUrl,
        });
        await openExternalUrl(result.authUrl);
      } catch (cause) {
        setError(formatError(cause, "Discord connector failed to start."));
      } finally {
        setActionPending(false);
      }
    },
    [side],
  );

  const disconnect = useCallback(async () => {
    try {
      setActionPending(true);
      const nextStatus = await client.disconnectDiscordConnector({
        side,
        provider: "discord",
      });
      setStatus(nextStatus);
      setError(null);
    } catch (cause) {
      setError(formatError(cause, "Discord connector disconnect failed."));
    } finally {
      setActionPending(false);
    }
  }, [side]);

  return {
    status,
    loading,
    actionPending,
    error,
    connect,
    disconnect,
    refresh,
  } as const;
}
