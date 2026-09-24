/**
 * Resolves whether the home composer actually depends on local text inference,
 * then follows local-model readiness only for that route. Runtime placement and
 * model placement are separate: a local agent may still send text to Cerebras.
 */

import { normalizeServiceRoutingConfig } from "@elizaos/shared/contracts/service-routing";
import { resolveApiUrl } from "@elizaos/shared/utils/asset-url";
import { getElizaApiToken } from "@elizaos/shared/utils/eliza-globals";
import { useEffect, useState, useSyncExternalStore } from "react";
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
import { openEventSource } from "../../utils/event-source";
import { observeModelRoute } from "./model-route-recovery";

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

    let eventSource: ReturnType<typeof openEventSource> = null;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    const stopLocalTracking = () => {
      clearTimeout(refreshTimer);
      eventSource?.close();
      eventSource = null;
    };

    const recovery = observeModelRoute(
      async (signal) => {
        if (!supportsLocalInferenceStatus()) {
          stopLocalTracking();
          setStatus(NOT_REQUIRED);
          return null;
        }
        const modelConfig = await client.getModelsConfig({ signal });
        if (signal.aborted) return null;
        if (modelConfig.activeChat) {
          stopLocalTracking();
          setStatus(NOT_REQUIRED);
          return null;
        }

        const config = await client.getConfig();
        if (signal.aborted) return null;
        const textRoute = normalizeServiceRoutingConfig(
          config.serviceRouting,
        )?.llmText;
        const waitingForCloudRoute =
          textRoute?.backend === "elizacloud" &&
          textRoute.transport === "cloud-proxy";

        try {
          const hub = await client.getLocalInferenceHub();
          if (!signal.aborted) {
            setStatus(deriveHomeModelStatus(hub.textReadiness));
          }
        } catch {
          // error-policy:J4 Retain the last readiness state. A download event
          // or transport recovery can retry the unavailable local hub.
        }
        if (signal.aborted) return null;

        if (!eventSource && !getElizaApiToken()) {
          eventSource = openEventSource(
            appendTokenParam(
              resolveApiUrl("/api/local-inference/downloads/stream"),
            ),
            { withCredentials: false },
          );
          if (eventSource) {
            eventSource.onmessage = () => {
              clearTimeout(refreshTimer);
              refreshTimer = setTimeout(recovery.refresh, 400);
            };
          }
        }
        return waitingForCloudRoute ? CLOUD_ROUTE_RECHECK_MS : null;
      },
      () => {
        stopLocalTracking();
        setStatus(ROUTING_STATUS_ERROR);
      },
    );

    return () => {
      recovery.close();
      stopLocalTracking();
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
