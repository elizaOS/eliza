import { client } from "@elizaos/ui";
import { useCallback, useEffect, useState } from "react";
import type { LifeOpsScheduleSummary } from "../lifeops/schedule-insight.js";

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
 * Loads the lightweight schedule summary (cached merged state + last 7 days
 * of persisted sleep episodes) at a steady cadence. Reads from cached
 * tables only — the scheduler tick is the sole writer. Safe to call on
 * every panel mount without triggering probes.
 */
export function useLifeOpsScheduleInspection(
  options: UseLifeOpsScheduleInspectionOptions = {},
) {
  const [inspection, setInspection] = useState<LifeOpsScheduleSummary | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (isCancelled?: () => boolean) => {
      setLoading(true);
      try {
        const timezone =
          options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        const response = await client.getLifeOpsScheduleSummary(timezone);
        if (isCancelled?.()) return;
        setInspection(response);
        setError(null);
      } catch (cause) {
        if (isCancelled?.()) return;
        setError(
          formatError(cause, "LifeOps schedule summary failed to load."),
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
