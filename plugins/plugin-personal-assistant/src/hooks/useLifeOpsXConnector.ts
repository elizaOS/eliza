/**
 * React hook exposing the X (Twitter) LifeOps connector status (owner or agent
 * side), its connect controls, and a post action. The X transport client lives
 * in `@elizaos/plugin-x`; this hook reads and toggles the normalized connector
 * status for the UI.
 */
import type {
  LifeOpsConnectorSide,
  LifeOpsXConnectorStatus,
  LifeOpsXPostResponse,
} from "@elizaos/shared";
import { client } from "@elizaos/ui";
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

  const post = useCallback(
    async (text: string, mode?: LifeOpsXConnectorStatus["mode"]) => {
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

  return {
    status,
    loading,
    actionPending,
    error,
    lastPost,
    refresh,
    post,
  } as const;
}
