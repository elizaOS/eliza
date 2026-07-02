/**
 * Generic GET-status hook for token-credential cloud connectors (Twilio,
 * Blooio, WhatsApp, Telegram).
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, api } from "../lib/api-client";

export function useConnectionStatus<TStatus>(
  endpoint: string,
  errorMessage = "Failed to fetch connection status",
) {
  const [status, setStatus] = useState<TStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(
    async (signal?: AbortSignal) => {
      setIsLoading(true);
      try {
        const data = await api<TStatus>(endpoint, { signal });
        if (signal?.aborted) return;
        setStatus(data);
      } catch (error) {
        if (!signal?.aborted) {
          const message =
            error instanceof ApiError
              ? error.message
              : error instanceof Error
                ? error.message
                : errorMessage;
          toast.error(message || errorMessage);
        }
      } finally {
        if (!signal?.aborted) {
          setIsLoading(false);
        }
      }
    },
    [endpoint, errorMessage],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refetch(controller.signal);
    return () => controller.abort();
  }, [refetch]);

  return { status, isLoading, refetch };
}
