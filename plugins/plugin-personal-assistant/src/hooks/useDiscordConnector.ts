/**
 * React hook exposing the LifeOps Discord connector status (owner or agent
 * side) and its connect/disconnect controls, polling the LifeOps connector API.
 * The Discord transport client itself lives in `@elizaos/plugin-discord`; this
 * hook only reads and toggles the normalized connector status for the UI.
 */
import type {
  LifeOpsConnectorSide,
  LifeOpsDiscordConnectorStatus,
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

  return {
    status,
    loading,
    error,
    refresh,
  } as const;
}
