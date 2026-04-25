import { client } from "@elizaos/app-core/api";
import type { LifeOpsWhatsAppConnectorStatus } from "@elizaos/shared/contracts/lifeops";
import { useCallback, useEffect, useState } from "react";

function formatError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }
  return fallback;
}

export function useWhatsAppConnector() {
  const [status, setStatus] = useState<LifeOpsWhatsAppConnectorStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextStatus = await client.getWhatsAppConnectorStatus();
      setStatus(nextStatus);
      setError(null);
    } catch (cause) {
      setError(formatError(cause, "WhatsApp connector status failed to load."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const nextStatus = await client.getWhatsAppConnectorStatus();
        if (cancelled) return;
        setStatus(nextStatus);
        setError(null);
      } catch (cause) {
        if (cancelled) return;
        setError(
          formatError(cause, "WhatsApp connector status failed to load."),
        );
      } finally {
        if (!cancelled) setLoading(false);
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
