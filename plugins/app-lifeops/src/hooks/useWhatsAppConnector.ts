import { client } from "@elizaos/ui";
import type { LifeOpsWhatsAppConnectorStatus } from "@elizaos/shared";
import { useCallback, useEffect, useState } from "react";
import { formatConnectorError } from "./connector-error.js";

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
      setError(
        formatConnectorError(
          cause,
          "WhatsApp connector status failed to load.",
        ),
      );
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
          formatConnectorError(
            cause,
            "WhatsApp connector status failed to load.",
          ),
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
