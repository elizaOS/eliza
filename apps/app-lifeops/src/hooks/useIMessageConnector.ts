import type { LifeOpsIMessageConnectorStatus } from "@elizaos/shared/contracts/lifeops";
import { useCallback, useEffect, useState } from "react";
import { client } from "@elizaos/app-core/api";

function formatError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }
  return fallback;
}

export function useIMessageConnector() {
  const [status, setStatus] = useState<LifeOpsIMessageConnectorStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextStatus = await client.getIMessageConnectorStatus();
      setStatus(nextStatus);
      setError(null);
    } catch (cause) {
      setError(formatError(cause, "iMessage connector status failed to load."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const nextStatus = await client.getIMessageConnectorStatus();
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
          formatError(cause, "iMessage connector status failed to load."),
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
  }, []);

  return {
    status,
    loading,
    error,
    refresh,
  } as const;
}
