import { client, isApiError, useApp } from "@elizaos/app-core";
import type { LifeOpsOverview } from "@elizaos/shared";
import { useCallback, useEffect, useState } from "react";
import { useLifeOpsAppState } from "../../../../../hooks/useLifeOpsAppState.js";

const LIFEOPS_REFRESH_INTERVAL_MS = 15_000;

function isLifeOpsRuntimeReady(args: {
  startupPhase?: string | null;
  agentState?: string | null;
  backendState?: string | null;
}): boolean {
  return (
    args.startupPhase === "ready" &&
    args.agentState === "running" &&
    args.backendState === "connected"
  );
}

function isTransientLifeOpsAvailabilityError(cause: unknown): boolean {
  return (
    isApiError(cause) &&
    cause.kind === "http" &&
    cause.status === 503 &&
    cause.path === "/api/lifeops/overview"
  );
}

export interface UseLifeOpsOverviewDataResult {
  overview: LifeOpsOverview | null;
  loading: boolean;
  error: string | null;
  lifeOpsEnabled: boolean;
  reload: () => Promise<void>;
}

/**
 * Shared hook used by all four LifeOps sidebar widgets.
 * Fetches `/api/lifeops/overview` once and polls every 15 s.
 * Widgets consuming this hook do not issue independent fetches.
 */
export function useLifeOpsOverviewData(): UseLifeOpsOverviewDataResult {
  const lifeOpsApp = useLifeOpsAppState();
  const { agentStatus, backendConnection, startupPhase } = useApp();
  const [overview, setOverview] = useState<LifeOpsOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runtimeReady = isLifeOpsRuntimeReady({
    startupPhase: lifeOpsApp.enabled ? startupPhase : null,
    agentState: agentStatus?.state ?? null,
    backendState: backendConnection?.state ?? null,
  });

  const loadOverview = useCallback(
    async (silent = false) => {
      if (!runtimeReady) {
        setLoading(false);
        return;
      }
      if (!silent) {
        setLoading(true);
      }
      const next = await client.getLifeOpsOverview();
      setOverview(next);
      setError(null);
      setLoading(false);
    },
    [runtimeReady],
  );

  useEffect(() => {
    if (!runtimeReady) {
      setLoading(false);
      setError(null);
      return;
    }
    let active = true;

    void (async () => {
      try {
        await loadOverview(false);
      } catch (cause) {
        if (isTransientLifeOpsAvailabilityError(cause)) {
          setLoading(false);
          return;
        }
        setOverview(null);
        setError(
          cause instanceof Error && cause.message.trim().length > 0
            ? cause.message.trim()
            : "LifeOps failed to refresh.",
        );
        setLoading(false);
      }
    })();

    const intervalId = window.setInterval(() => {
      if (!active) return;
      void (async () => {
        try {
          await loadOverview(true);
        } catch (cause) {
          if (isTransientLifeOpsAvailabilityError(cause)) return;
          setError(
            cause instanceof Error && cause.message.trim().length > 0
              ? cause.message.trim()
              : "LifeOps failed to refresh.",
          );
        }
      })();
    }, LIFEOPS_REFRESH_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [loadOverview, runtimeReady]);

  const reload = useCallback(() => loadOverview(false), [loadOverview]);

  return {
    overview,
    loading,
    error,
    lifeOpsEnabled: !lifeOpsApp.loading && lifeOpsApp.enabled,
    reload,
  };
}
