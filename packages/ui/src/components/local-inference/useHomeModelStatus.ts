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

    const refresh = async () => {
      if (!supportsLocalInferenceStatus()) {
        if (!cancelled) setStatus(NOT_REQUIRED);
        return;
      }
      try {
        const hub = await client.getLocalInferenceHub();
        if (!cancelled) setStatus(deriveHomeModelStatus(hub.textReadiness));
      } catch {
        // Keep the last good status; the stream will trigger another refresh.
      }
    };

    const start = async () => {
      try {
        const modelConfig = await client.getModelsConfig();
        if (cancelled) return;
        if (modelConfig.activeChat) {
          setStatus(NOT_REQUIRED);
          return;
        }
      } catch {
        // error-policy:J4 The composer distinguishes an unavailable routing
        // probe from both a healthy external route and local-model readiness.
        if (!cancelled) setStatus(ROUTING_STATUS_ERROR);
        return;
      }

      await refresh();
      if (cancelled || !supportsLocalInferenceStatus()) return;

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
    };
    void start();

    return () => {
      cancelled = true;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      eventSource?.close();
    };
  }, [
    authenticated,
    runtimeMode.isCloudMode,
    runtimeMode.isRemoteMode,
    runtimeMode.state.phase,
  ]);

  return status;
}
