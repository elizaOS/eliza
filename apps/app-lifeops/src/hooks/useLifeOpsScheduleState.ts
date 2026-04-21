import { client } from "@elizaos/app-core/api";
import type { LifeOpsScheduleMergedState } from "../lifeops/schedule-sync-contracts.js";
import { useCallback, useEffect, useState } from "react";

function formatError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }
  return fallback;
}

export interface UseLifeOpsScheduleStateOptions {
  timezone?: string | null;
  scope?: "local" | "cloud" | "effective";
}

export function useLifeOpsScheduleState(
  options: UseLifeOpsScheduleStateOptions = {},
) {
  const [state, setState] = useState<LifeOpsScheduleMergedState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await client.getLifeOpsScheduleMergedState({
        timezone: options.timezone ?? undefined,
        scope: options.scope,
        refresh: false,
      });
      setState(response.mergedState);
      setError(null);
    } catch (cause) {
      setError(formatError(cause, "LifeOps schedule state failed to load."));
    } finally {
      setLoading(false);
    }
  }, [options.scope, options.timezone]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const response = await client.getLifeOpsScheduleMergedState({
          timezone: options.timezone ?? undefined,
          scope: options.scope,
          refresh: false,
        });
        if (cancelled) {
          return;
        }
        setState(response.mergedState);
        setError(null);
      } catch (cause) {
        if (cancelled) {
          return;
        }
        setError(formatError(cause, "LifeOps schedule state failed to load."));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [options.scope, options.timezone]);

  return {
    state,
    loading,
    error,
    refresh,
  } as const;
}
