"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

export interface UseConnectionStatusResult<T> {
  status: T | null;
  isLoading: boolean;
  refetch: () => void;
}

/**
 * Fetches and tracks a connection's status from a single GET endpoint.
 *
 * Handles AbortController cleanup on unmount/refetch, shows a toast on network
 * failure, and exposes a `refetch` function for post-connect/disconnect
 * refreshes. All connection components (Blooio, Telegram, WhatsApp, Twilio, …)
 * share this pattern — use this hook instead of duplicating it.
 */
export function useConnectionStatus<T>(
  url: string,
  errorMessage: string,
): UseConnectionStatusResult<T> {
  const [status, setStatus] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [fetchTrigger, setFetchTrigger] = useState(0);

  const refetch = useCallback(() => {
    setFetchTrigger((n) => n + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: fetchTrigger included so refetch() can manually re-run the effect
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    const load = async () => {
      setIsLoading(true);
      try {
        const response = await fetch(url, { signal });
        if (!signal.aborted) {
          setStatus((await response.json()) as T);
        }
      } catch {
        if (!signal.aborted) {
          toast.error(errorMessage);
        }
      } finally {
        if (!signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    void load();
    return () => controller.abort();
  }, [url, errorMessage, fetchTrigger]);

  return { status, isLoading, refetch };
}
