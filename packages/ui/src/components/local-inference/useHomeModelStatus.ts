/**
 * Resolves whether the home composer actually depends on local text inference,
 * then follows local-model readiness only for that route. Runtime placement and
 * model placement are separate: a local agent may still send text to Cerebras.
 */

import { normalizeServiceRoutingConfig } from "@elizaos/shared";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { client } from "../../api";
import { supportsFullAppShellRoutes } from "../../api/app-shell-capabilities";
import { isDesktopExternalApiBaseUrl } from "../../api/desktop-external-api-base";
import { MOBILE_RUNTIME_MODE_CHANGED_EVENT } from "../../events";
import { readPersistedMobileRuntimeMode } from "../../first-run/mobile-runtime-mode";
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

const CLOUD_ROUTE_RECHECK_MS = 1_000;

function subscribeToMobileRuntimeMode(onStoreChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener(MOBILE_RUNTIME_MODE_CHANGED_EVENT, onStoreChange);
  return () => {
    document.removeEventListener(
      MOBILE_RUNTIME_MODE_CHANGED_EVENT,
      onStoreChange,
    );
  };
}

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
  const routingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mobileRuntimeMode = useSyncExternalStore(
    subscribeToMobileRuntimeMode,
    readPersistedMobileRuntimeMode,
    () => null,
  );
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
      mobileRuntimeMode === "remote-mac" ||
      mobileRuntimeMode === "tunnel-to-mobile" ||
      !supportsLocalInferenceStatus()
    ) {
      setStatus(NOT_REQUIRED);
      return;
    }

    let cancelled = false;
    let eventSource: ReturnType<typeof openEventSource> = null;
    let activeRouteResolved = false;

    const stopLocalStatusTracking = (nextStatus: HomeModelStatus) => {
      activeRouteResolved = true;
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      if (routingTimerRef.current) {
        clearTimeout(routingTimerRef.current);
        routingTimerRef.current = null;
      }
      eventSource?.close();
      eventSource = null;
      if (!cancelled) setStatus(nextStatus);
    };

    const probeActiveRoute = async (): Promise<
      "active" | "pending" | "error"
    > => {
      try {
        const modelConfig = await client.getModelsConfig();
        if (cancelled) return "pending";
        if (modelConfig.activeChat) {
          stopLocalStatusTracking(NOT_REQUIRED);
          return "active";
        }
        return "pending";
      } catch {
        // error-policy:J4 The composer distinguishes an unavailable routing
        // probe from both a healthy external route and local-model readiness.
        stopLocalStatusTracking(ROUTING_STATUS_ERROR);
        return "error";
      }
    };

    const scheduleCloudRouteRecheck = () => {
      if (cancelled || activeRouteResolved || routingTimerRef.current) return;
      routingTimerRef.current = setTimeout(() => {
        routingTimerRef.current = null;
        void probeActiveRoute().then((result) => {
          if (result === "pending") scheduleCloudRouteRecheck();
        });
      }, CLOUD_ROUTE_RECHECK_MS);
    };

    const refresh = async () => {
      if (!supportsLocalInferenceStatus()) {
        if (!cancelled) setStatus(NOT_REQUIRED);
        return;
      }
      try {
        const hub = await client.getLocalInferenceHub();
        if (!cancelled && !activeRouteResolved) {
          setStatus(deriveHomeModelStatus(hub.textReadiness));
        }
      } catch {
        // Keep the last good status; the stream will trigger another refresh.
      }
    };

    const start = async () => {
      const routeState = await probeActiveRoute();
      if (routeState !== "pending" || cancelled) return;

      try {
        const config = await client.getConfig();
        if (cancelled) return;
        const textRoute = normalizeServiceRoutingConfig(
          config.serviceRouting,
        )?.llmText;
        if (
          textRoute?.backend === "elizacloud" &&
          textRoute.transport === "cloud-proxy"
        ) {
          scheduleCloudRouteRecheck();
        }
      } catch {
        // error-policy:J4 Without the configured-route snapshot the composer
        // cannot safely decide whether local readiness is relevant.
        stopLocalStatusTracking(ROUTING_STATUS_ERROR);
        return;
      }

      await refresh();
      if (cancelled || !supportsLocalInferenceStatus()) return;

      const url = appendTokenParam(
        resolveApiUrl("/api/local-inference/downloads/stream"),
      );
      // On-device runtimes are addressed via the native IPC base, which
      // EventSource cannot open — fall back to the one-shot `refresh()` above.
      eventSource = getElizaApiToken()
        ? null
        : openEventSource(url, { withCredentials: false });
      if (eventSource) {
        eventSource.onmessage = () => {
          // The stream carries download/active deltas but not recomputed
          // readiness, so debounce a hub refetch to pick up the fresh
          // `textReadiness` rather than recomputing it client-side.
          if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
          refreshTimerRef.current = setTimeout(() => void refresh(), 400);
        };
      }
    };
    void start();

    return () => {
      cancelled = true;
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      if (routingTimerRef.current) {
        clearTimeout(routingTimerRef.current);
        routingTimerRef.current = null;
      }
      eventSource?.close();
    };
  }, [
    authenticated,
    mobileRuntimeMode,
    runtimeMode.isCloudMode,
    runtimeMode.isRemoteMode,
    runtimeMode.state.phase,
  ]);

  return status;
}
