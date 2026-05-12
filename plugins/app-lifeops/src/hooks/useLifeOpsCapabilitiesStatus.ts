import { client } from "@elizaos/ui";
import type { LifeOpsCapabilitiesStatus } from "@elizaos/shared";
import { useCallback, useEffect, useState } from "react";

function formatError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }
  return fallback;
}

export function useLifeOpsCapabilitiesStatus() {
  const [status, setStatus] = useState<LifeOpsCapabilitiesStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await client.getLifeOpsCapabilitiesStatus());
      setError(null);
    } catch (cause) {
      setError(formatError(cause, "LifeOps capabilities failed to load."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const response = await client.getLifeOpsCapabilitiesStatus();
        if (cancelled) {
          return;
        }
        setStatus(response);
        setError(null);
      } catch (cause) {
        if (cancelled) {
          return;
        }
        setError(formatError(cause, "LifeOps capabilities failed to load."));
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
