import { client } from "@elizaos/app-core/api";
import type {
  LifeOpsConnectorMode,
  LifeOpsXCapability,
  LifeOpsXConnectorStatus,
  LifeOpsXPostResponse,
} from "@elizaos/shared/contracts/lifeops";
import { useCallback, useEffect, useState } from "react";

function formatError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }
  return fallback;
}

function defaultCapabilities(
  status: LifeOpsXConnectorStatus | null,
): LifeOpsXCapability[] {
  if (status?.grantedCapabilities.length > 0) {
    return status.grantedCapabilities;
  }
  return ["x.read", "x.write"];
}

export function useLifeOpsXConnector() {
  const [status, setStatus] = useState<LifeOpsXConnectorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastPost, setLastPost] = useState<LifeOpsXPostResponse | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextStatus = await client.getXLifeOpsConnectorStatus();
      setStatus(nextStatus);
      setError(null);
    } catch (cause) {
      setError(formatError(cause, "X connector status failed to load."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const nextStatus = await client.getXLifeOpsConnectorStatus();
        if (cancelled) {
          return;
        }
        setStatus(nextStatus);
        setError(null);
      } catch (cause) {
        if (cancelled) {
          return;
        }
        setError(formatError(cause, "X connector status failed to load."));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(
    async (mode?: LifeOpsConnectorMode) => {
      try {
        setActionPending(true);
        const nextStatus = await client.upsertXLifeOpsConnector({
          mode,
          capabilities: defaultCapabilities(status),
          grantedScopes: status?.grantedScopes ?? [],
          identity: status?.identity ?? undefined,
          metadata: {},
        });
        setStatus(nextStatus);
        setError(null);
      } catch (cause) {
        setError(formatError(cause, "X connector connect failed."));
      } finally {
        setActionPending(false);
      }
    },
    [status],
  );

  const post = useCallback(
    async (text: string, mode?: LifeOpsConnectorMode) => {
      try {
        setActionPending(true);
        setLastPost(null);
        const result = await client.createXLifeOpsPost({
          mode: mode ?? status?.mode,
          text,
          confirmPost: true,
        });
        setLastPost(result);
        setError(null);
      } catch (cause) {
        setError(formatError(cause, "X post failed."));
      } finally {
        setActionPending(false);
      }
    },
    [status?.mode],
  );

  return {
    status,
    loading,
    actionPending,
    error,
    lastPost,
    refresh,
    connect,
    post,
  } as const;
}
