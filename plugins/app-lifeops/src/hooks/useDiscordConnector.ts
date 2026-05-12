import type {
  LifeOpsConnectorSide,
  LifeOpsDiscordConnectorStatus,
  LifeOpsOwnerBrowserAccessSource,
} from "@elizaos/shared";
import { client } from "@elizaos/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatConnectorError } from "./connector-error.js";

export interface UseDiscordConnectorOptions {
  side?: LifeOpsConnectorSide;
}

const LOGIN_POLL_INTERVAL_MS = 3_000;

export function useDiscordConnector(options: UseDiscordConnectorOptions = {}) {
  const side = options.side ?? "owner";
  const [status, setStatus] = useState<LifeOpsDiscordConnectorStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextStatus = await client.getDiscordConnectorStatus(side);
      setStatus(nextStatus);
      setError(null);
    } catch (cause) {
      setError(
        formatConnectorError(cause, "Discord connector status failed to load."),
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
        const nextStatus = await client.getDiscordConnectorStatus(side);
        if (cancelled) return;
        setStatus(nextStatus);
        setError(null);
      } catch (cause) {
        if (cancelled) return;
        setError(
          formatConnectorError(
            cause,
            "Discord connector status failed to load.",
          ),
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [side]);

  useEffect(() => () => clearPoll(), [clearPoll]);

  useEffect(() => {
    const shouldPoll =
      status?.reason === "pairing" || status?.reason === "auth_pending";
    if (shouldPoll && !pollRef.current) {
      pollRef.current = setInterval(() => {
        void (async () => {
          try {
            const next = await client.getDiscordConnectorStatus(side);
            setStatus(next);
            if (next.reason !== "pairing" && next.reason !== "auth_pending") {
              clearPoll();
            }
            setError(null);
          } catch (cause) {
            setError(
              formatConnectorError(
                cause,
                "Discord connector status poll failed.",
              ),
            );
          }
        })();
      }, LOGIN_POLL_INTERVAL_MS);
    } else if (!shouldPoll) {
      clearPoll();
    }
  }, [status?.reason, side, clearPoll]);

  const connect = useCallback(
    async (source?: LifeOpsOwnerBrowserAccessSource) => {
      try {
        setActionPending(true);
        setError(null);
        const nextStatus = await client.startDiscordConnector({ side, source });
        setStatus(nextStatus);
      } catch (cause) {
        setError(
          formatConnectorError(cause, "Discord connector failed to start."),
        );
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
      setError(
        formatConnectorError(cause, "Discord connector disconnect failed."),
      );
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
