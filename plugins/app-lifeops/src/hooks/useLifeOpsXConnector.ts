import { client } from "@elizaos/app-core";
import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsXConnectorStatus,
  LifeOpsXPostResponse,
} from "@elizaos/shared";
import { useCallback, useEffect, useState } from "react";
import { formatConnectorError } from "./connector-error.js";

export function useLifeOpsXConnector(side: LifeOpsConnectorSide = "owner") {
  const [status, setStatus] = useState<LifeOpsXConnectorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastPost, setLastPost] = useState<LifeOpsXPostResponse | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextStatus = await client.getXLifeOpsConnectorStatus(
        undefined,
        side,
      );
      setStatus(nextStatus);
      setError(null);
    } catch (cause) {
      setError(
        formatConnectorError(cause, "X connector status failed to load."),
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
        const nextStatus = await client.getXLifeOpsConnectorStatus(
          undefined,
          side,
        );
        if (cancelled) {
          return;
        }
        setStatus(nextStatus);
        setError(null);
      } catch (cause) {
        if (cancelled) {
          return;
        }
        setError(
          formatConnectorError(cause, "X connector status failed to load."),
        );
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

  const connect = useCallback(
    async (mode?: LifeOpsConnectorMode) => {
      try {
        setActionPending(true);
        const connectMode =
          mode ?? status?.mode ?? status?.defaultMode ?? "local";
        const result = await client.startXLifeOpsConnector({
          mode: connectMode,
          side,
        });
        const nextStatus = await client.getXLifeOpsConnectorStatus(
          result.mode,
          side,
        );
        setStatus(nextStatus);
        setError(null);
      } catch (cause) {
        setError(formatConnectorError(cause, "X connector connect failed."));
      } finally {
        setActionPending(false);
      }
    },
    [side, status],
  );

  const post = useCallback(
    async (text: string, mode?: LifeOpsConnectorMode) => {
      try {
        setActionPending(true);
        setLastPost(null);
        const result = await client.createXLifeOpsPost({
          side,
          mode: mode ?? status?.mode,
          text,
          confirmPost: true,
        });
        setLastPost(result);
        setError(null);
      } catch (cause) {
        setError(formatConnectorError(cause, "X post failed."));
      } finally {
        setActionPending(false);
      }
    },
    [side, status?.mode],
  );

  const disconnect = useCallback(async () => {
    try {
      setActionPending(true);
      await client.disconnectXLifeOpsConnector({
        side,
        mode: status?.mode,
      });
      const nextStatus = await client.getXLifeOpsConnectorStatus(
        status?.mode,
        side,
      );
      setStatus(nextStatus);
      setError(null);
    } catch (cause) {
      setError(formatConnectorError(cause, "X connector disconnect failed."));
    } finally {
      setActionPending(false);
    }
  }, [side, status?.mode]);

  return {
    status,
    loading,
    actionPending,
    error,
    lastPost,
    refresh,
    connect,
    disconnect,
    post,
  } as const;
}
