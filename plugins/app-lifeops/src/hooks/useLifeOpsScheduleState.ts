import { client } from "@elizaos/ui";
import { useCallback, useEffect, useState } from "react";
import type { LifeOpsScheduleMergedState } from "../lifeops/schedule-sync-contracts.js";

function formatError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }
  return fallback;
}

export interface UseLifeOpsScheduleStateOptions {
  timezone?: string | null;
  scope?: "local" | "cloud" | "effective";
  refreshIntervalMs?: number;
  refreshOnWindowFocus?: boolean;
}

export function useLifeOpsScheduleState(
  options: UseLifeOpsScheduleStateOptions = {},
) {
  const [state, setState] = useState<LifeOpsScheduleMergedState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (forceRefresh: boolean, isCancelled?: () => boolean) => {
      setLoading(true);
      try {
        const response = await client.getLifeOpsScheduleMergedState({
          timezone: options.timezone ?? undefined,
          scope: options.scope,
          refresh: forceRefresh,
        });
        if (isCancelled?.()) {
          return;
        }
        setState(response.mergedState);
        setError(null);
      } catch (cause) {
        if (isCancelled?.()) {
          return;
        }
        setError(formatError(cause, "LifeOps schedule state failed to load."));
      } finally {
        if (!isCancelled?.()) {
          setLoading(false);
        }
      }
    },
    [options.scope, options.timezone],
  );

  const refresh = useCallback(async () => {
    await load(true);
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void load(false, () => cancelled);

    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    const intervalMs = options.refreshIntervalMs ?? 60_000;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return;
    }
    const intervalId = window.setInterval(() => {
      void load(false);
    }, intervalMs);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [load, options.refreshIntervalMs]);

  useEffect(() => {
    if (options.refreshOnWindowFocus === false) {
      return;
    }
    const handleFocus = () => {
      void load(false);
    };
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [load, options.refreshOnWindowFocus]);

  return {
    state,
    loading,
    error,
    refresh,
  } as const;
}
