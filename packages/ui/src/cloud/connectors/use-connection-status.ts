/**
 * Generic GET-status hook for token-credential cloud connectors (Twilio,
 * Blooio, WhatsApp, Telegram).
 *
 * Three-state contract (#12784/#13419): a status fetch resolves into exactly
 * one of
 *   - loading      — the probe is in flight and no status is known yet;
 *   - a status      — the server answered (connected / not-connected are then
 *     read off the returned payload by the caller);
 *   - error         — the probe FAILED (transport / 5xx / parse / auth). This
 *     is deliberately distinguishable from a healthy "not connected" status:
 *     previously a failed fetch left `status` at `null` with only a transient
 *     toast, so the connector surface rendered the "disconnected" setup form —
 *     indistinguishable from a genuinely unconfigured connector even though the
 *     backend was unreachable. `isError`/`errorMessage` now expose that failure
 *     so callers can render a real error state instead of a fabricated
 *     "not connected".
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, api } from "../lib/api-client";

export interface ConnectionStatusResult<TStatus> {
  /** Last successfully fetched status payload, or `null` before the first
   *  successful fetch. Only meaningful when `isError` is false. */
  status: TStatus | null;
  /** The probe is in flight. */
  isLoading: boolean;
  /** The most recent probe FAILED (transport / 5xx / parse / auth). When true,
   *  `status` is stale/absent and must NOT be read as a healthy state. */
  isError: boolean;
  /** Human-readable failure reason for the error surface, or `null` when the
   *  last probe succeeded. */
  errorMessage: string | null;
  /** Re-run the status probe (used by both mount and an error-state retry). */
  refetch: (signal?: AbortSignal) => Promise<void>;
}

export function useConnectionStatus<TStatus>(
  endpoint: string,
  errorMessage = "Failed to fetch connection status",
): ConnectionStatusResult<TStatus> {
  const [status, setStatus] = useState<TStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(
    async (signal?: AbortSignal) => {
      setIsLoading(true);
      try {
        const data = await api<TStatus>(endpoint, { signal });
        if (signal?.aborted) return;
        setStatus(data);
        // A successful probe clears any prior failure so the surface leaves the
        // error state instead of leaving a stale error banner up.
        setError(null);
      } catch (err) {
        if (!signal?.aborted) {
          const message =
            err instanceof ApiError
              ? err.message
              : err instanceof Error
                ? err.message
                : errorMessage;
          const resolved = message || errorMessage;
          // error-policy:J4 status probe failed — surface a distinguishable
          // error state (not a fabricated "disconnected"). The toast stays for
          // immediacy; `isError` is the durable signal the connector card reads
          // so a broken/unreachable backend never renders as "not connected".
          setError(resolved);
          toast.error(resolved);
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

  return {
    status,
    isLoading,
    isError: error !== null,
    errorMessage: error,
    refetch,
  };
}
