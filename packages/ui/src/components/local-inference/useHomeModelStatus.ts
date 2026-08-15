/**
 * Resolves whether the home composer actually depends on local text inference,
 * then follows local-model readiness only for that route. Runtime placement and
 * model placement are separate: a local agent may still send text to Cerebras.
 */

import { useEffect, useRef, useState } from "react";

import { client } from "../../api";
import { supportsFullAppShellRoutes } from "../../api/app-shell-capabilities";
import { isDesktopExternalApiBaseUrl } from "../../api/desktop-external-api-base";
import { useIsAuthenticated } from "../../hooks/useAuthStatus";
import { useRuntimeMode } from "../../hooks/useRuntimeMode";
import {
  deriveHomeModelStatus,
  type HomeModelStatus,
} from "../../services/local-inference/home-model-status";
import { resolveApiUrl } from "../../utils/asset-url";
import { getElizaApiToken } from "../../utils/eliza-globals";
import { openEventSource } from "../../utils/event-source";

const NOT_REQUIRED: HomeModelStatus = {
  kind: "not-required",
  blocksSend: false,
  percent: null,
  etaMs: null,
  modelName: null,
  errors: [],
};

const ROUTING_STATUS_ERROR: HomeModelStatus = {
  kind: "error",
  blocksSend: true,
  percent: null,
  etaMs: null,
  modelName: null,
  errors: ["Could not verify the active text model provider."],
};

// The shell can become ready before deferred provider plugins finish
// registering their model handlers. Re-probe for a bounded startup window so
// that truthful `activeChat: null` snapshots do not become a permanent local
// inference decision. The cumulative window is 15.75 seconds.
const ROUTE_RECHECK_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000];

type RouteProbeResult = "active" | "local" | "unavailable";

function appendTokenParam(url: string): string {
  const token = getElizaApiToken()?.trim();
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

function supportsLocalInferenceStatus(): boolean {
  const baseUrl = client.getBaseUrl();
  return (
    supportsFullAppShellRoutes(baseUrl) && !isDesktopExternalApiBaseUrl(baseUrl)
  );
}

/**
 * Collapses the local-inference hub's per-slot text readiness into a single
 * home-surface status, refreshed live from the download stream. The effective
 * model route is checked first so a local runtime backed by Cerebras or another
 * external provider never displays or gates on an unrelated local text model.
 */
export function useHomeModelStatus(): HomeModelStatus {
  const [status, setStatus] = useState<HomeModelStatus>(NOT_REQUIRED);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runtimeMode = useRuntimeMode();
  // Auth gate (#11084): the shell mounts this hook before the auth probe
  // resolves, so the download SSE stream + hub fetches must stay dormant until
  // the session is authenticated (an unauthenticated tab otherwise streams
  // 401s into the rate limiter).
  const authenticated = useIsAuthenticated();

  useEffect(() => {
    if (
      !authenticated ||
      runtimeMode.state.phase === "loading" ||
      runtimeMode.isCloudMode ||
      runtimeMode.isRemoteMode ||
      !supportsLocalInferenceStatus()
    ) {
      setStatus(NOT_REQUIRED);
      return;
    }

    let cancelled = false;
    let eventSource: ReturnType<typeof openEventSource> = null;
    let routeRecheckTimer: ReturnType<typeof setTimeout> | null = null;
    let routeRecheckIndex = 0;
    let routeSettledActive = false;

    const stopLocalTracking = () => {
      if (routeRecheckTimer) clearTimeout(routeRecheckTimer);
      routeRecheckTimer = null;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
      eventSource?.close();
      eventSource = null;
    };

    const refresh = async (): Promise<RouteProbeResult> => {
      if (routeSettledActive) return "active";
      if (!supportsLocalInferenceStatus()) {
        if (!cancelled) {
          routeSettledActive = true;
          stopLocalTracking();
          setStatus(NOT_REQUIRED);
        }
        return "active";
      }

      try {
        const modelConfig = await client.getModelsConfig();
        if (cancelled) return "unavailable";
        if (modelConfig.activeChat) {
          routeSettledActive = true;
          stopLocalTracking();
          setStatus(NOT_REQUIRED);
          return "active";
        }
      } catch {
        // error-policy:J4 The composer distinguishes an unavailable routing
        // probe from both a healthy external route and local-model readiness.
        if (!cancelled && !routeSettledActive) setStatus(ROUTING_STATUS_ERROR);
        return "unavailable";
      }

      try {
        const hub = await client.getLocalInferenceHub();
        if (!cancelled && !routeSettledActive)
          setStatus(deriveHomeModelStatus(hub.textReadiness));
      } catch {
        // error-policy:J4 Keep the last good visible status; the stream or
        // bounded route probe will trigger another authoritative refresh.
      }
      return routeSettledActive ? "active" : "local";
    };

    const scheduleRouteRecheck = () => {
      if (cancelled || routeRecheckIndex >= ROUTE_RECHECK_DELAYS_MS.length)
        return;
      const delay = ROUTE_RECHECK_DELAYS_MS[routeRecheckIndex++];
      routeRecheckTimer = setTimeout(() => {
        routeRecheckTimer = null;
        void refresh().then((result) => {
          if (result !== "active") scheduleRouteRecheck();
        });
      }, delay);
    };

    const start = async () => {
      const route = await refresh();
      if (cancelled || route !== "local" || !supportsLocalInferenceStatus())
        return;

      const url = appendTokenParam(
        resolveApiUrl("/api/local-inference/downloads/stream"),
      );
      // On-device runtimes are addressed via the native IPC base, which
      // EventSource cannot open — fall back to the one-shot `refresh()` above.
      eventSource = openEventSource(url, { withCredentials: false });
      if (eventSource) {
        eventSource.onmessage = () => {
          // The stream carries download/active deltas but not recomputed
          // readiness, so debounce a hub refetch to pick up the fresh
          // `textReadiness` rather than recomputing it client-side.
          if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
          refreshTimerRef.current = setTimeout(() => void refresh(), 400);
        };
      }
      scheduleRouteRecheck();
    };
    void start();

    return () => {
      cancelled = true;
      stopLocalTracking();
    };
  }, [
    authenticated,
    runtimeMode.isCloudMode,
    runtimeMode.isRemoteMode,
    runtimeMode.state.phase,
  ]);

  return status;
}
