import { client } from "@elizaos/app-core/api";
import { useCallback, useEffect, useState } from "react";
import type { LifeOpsScheduleInspection } from "../lifeops/schedule-insight.js";

function formatError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }
  return fallback;
}

export interface UseLifeOpsScheduleInspectionOptions {
  timezone?: string;
  refreshIntervalMs?: number;
}

/**
 * Loads the server-side schedule inspection (insight + sleep episodes +
 * merged-window inventory + contributing rules) at a steady cadence.
 *
 * The inspection object is the same shape returned by
 * `service.inspectSchedule`, and the underlying route
 * (`GET /api/lifeops/schedule/inspection`) runs live against the repository
 * each time — UI callers should debounce/throttle visibility gates if they
 * only need a snapshot on demand (`refreshIntervalMs <= 0`).
 */
export function useLifeOpsScheduleInspection(
  options: UseLifeOpsScheduleInspectionOptions = {},
) {
  const [inspection, setInspection] =
    useState<LifeOpsScheduleInspection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (isCancelled?: () => boolean) => {
      setLoading(true);
      try {
        const timezone =
          options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        const response = await client.getLifeOpsScheduleInspection(timezone);
        if (isCancelled?.()) return;
        setInspection(response);
        setError(null);
      } catch (cause) {
        if (isCancelled?.()) return;
        setError(
          formatError(cause, "LifeOps schedule inspection failed to load."),
        );
      } finally {
        if (!isCancelled?.()) setLoading(false);
      }
    },
    [options.timezone],
  );

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    const intervalMs = options.refreshIntervalMs ?? 120_000;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    const intervalId = window.setInterval(() => {
      void load();
    }, intervalMs);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [load, options.refreshIntervalMs]);

  return {
    inspection,
    loading,
    error,
    refresh,
  } as const;
}
