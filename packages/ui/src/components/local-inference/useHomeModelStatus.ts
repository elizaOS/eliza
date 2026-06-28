import { useEffect, useRef, useState } from "react";

import { client } from "../../api";
import { supportsFullAppShellRoutes } from "../../api/app-shell-capabilities";
import { isDesktopExternalApiBaseUrl } from "../../api/desktop-external-api-base";
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

function appendTokenParam(url: string): string {
  const token = getElizaApiToken()?.trim();
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

/**
 * Collapses the local-inference hub's per-slot text readiness into a single
 * home-surface status, refreshed live from the download stream. Defaults to
 * `not-required` so cloud/remote runtimes never gate send before the first
 * hub fetch resolves.
 */
export function useHomeModelStatus(): HomeModelStatus {
  const [status, setStatus] = useState<HomeModelStatus>(NOT_REQUIRED);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runtimeMode = useRuntimeMode();

  useEffect(() => {
    if (
      runtimeMode.state.phase === "loading" ||
      runtimeMode.isCloudMode ||
      runtimeMode.isRemoteMode ||
      !supportsFullAppShellRoutes(client.getBaseUrl()) ||
      isDesktopExternalApiBaseUrl(client.getBaseUrl())
    ) {
      setStatus(NOT_REQUIRED);
      return;
    }

    let cancelled = false;

    const refresh = async () => {
      try {
        const hub = await client.getLocalInferenceHub();
        if (!cancelled) setStatus(deriveHomeModelStatus(hub.textReadiness));
      } catch {
        // Keep the last good status; the stream will trigger another refresh.
      }
    };

    void refresh();

    const url = appendTokenParam(
      resolveApiUrl("/api/local-inference/downloads/stream"),
    );
    // On-device runtimes are addressed via the native IPC base, which
    // EventSource cannot open — fall back to the one-shot `refresh()` above.
    const es = openEventSource(url, { withCredentials: false });
    if (es) {
      es.onmessage = () => {
        // The stream carries download/active deltas but not recomputed
        // readiness, so debounce a hub refetch to pick up the fresh
        // `textReadiness` rather than recomputing it client-side.
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(() => void refresh(), 400);
      };
    }

    return () => {
      cancelled = true;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      es?.close();
    };
  }, [
    runtimeMode.isCloudMode,
    runtimeMode.isRemoteMode,
    runtimeMode.state.phase,
  ]);

  return status;
}
