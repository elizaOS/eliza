import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../api";
import type { StartupShellView } from "../components/shell/startup-shell-types";
import { CONNECT_EVENT } from "../events";
import { ensureStoreBuildWorkspaceFolder } from "../first-run/ensure-store-build-workspace-folder";
import { persistMobileRuntimeModeForServerTarget } from "../first-run/mobile-runtime-mode";
import { applyLaunchConnection } from "../platform";
import type { StartupErrorReason, StartupErrorState } from "./types";
import { useApp } from "./useApp";

function phaseToStatusKey(phase: string): string {
  switch (phase) {
    case "restoring-session":
      return "startupshell.Starting";
    case "resolving-target":
    case "polling-backend":
      return "startupshell.ConnectingBackend";
    case "starting-runtime":
      return "startupshell.InitializingAgent";
    case "hydrating":
    case "ready":
      return "startupshell.Loading";
    default:
      return "startupshell.Starting";
  }
}

function needsBootstrapSession(): boolean {
  try {
    return !sessionStorage.getItem("eliza_session");
  } catch {
    return true;
  }
}

export interface StartupShellController {
  view: StartupShellView;
  retryStartup: () => void;
}

export function useStartupShellController(): StartupShellController {
  const {
    startupCoordinator,
    startupError,
    firstRunComplete,
    firstRunCloudProvisionedContainer,
    retryStartup,
    setActionNotice,
    setState,
    t,
  } = useApp();
  const phase = startupCoordinator.phase;
  const [showBootstrap, setShowBootstrap] = useState(false);
  const cloudSkipProbeStartedRef = useRef(false);
  const coordinatorDispatchRef = useRef(startupCoordinator.dispatch);
  const coordinatorStateRef = useRef(startupCoordinator.state);

  coordinatorDispatchRef.current = startupCoordinator.dispatch;
  coordinatorStateRef.current = startupCoordinator.state;

  useEffect(() => {
    const handleConnect = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail;
      const payload =
        detail && typeof detail === "object" && !Array.isArray(detail)
          ? (detail as { gatewayUrl?: unknown; token?: unknown })
          : null;
      if (typeof payload?.gatewayUrl !== "string") {
        return;
      }

      try {
        const connection = applyLaunchConnection({
          kind: "remote",
          apiBase: payload.gatewayUrl,
          token: typeof payload.token === "string" ? payload.token : null,
          allowPublicHttps: true,
        });
        persistMobileRuntimeModeForServerTarget("remote");
        setState("firstRunRuntimeTarget", "remote");
        setState("firstRunRemoteApiBase", connection.apiBase);
        setState("firstRunRemoteToken", connection.token ?? "");
        setState("firstRunRemoteConnected", true);
        setState("firstRunRemoteError", null);
        setActionNotice("Connected to remote backend.", "success", 4200);
        retryStartup();
      } catch (err) {
        setActionNotice(
          err instanceof Error
            ? err.message
            : "Failed to connect remote backend.",
          "error",
          8000,
        );
      }
    };

    document.addEventListener(CONNECT_EVENT, handleConnect);
    return () => document.removeEventListener(CONNECT_EVENT, handleConnect);
  }, [retryStartup, setActionNotice, setState]);

  useEffect(() => {
    void ensureStoreBuildWorkspaceFolder();
  }, []);

  useEffect(() => {
    if (phase !== "first-run-required") {
      cloudSkipProbeStartedRef.current = false;
      return;
    }

    const coordState = coordinatorStateRef.current;
    if (
      coordState.phase !== "first-run-required" ||
      coordState.serverReachable ||
      cloudSkipProbeStartedRef.current
    ) {
      return;
    }

    cloudSkipProbeStartedRef.current = true;
    let cancelled = false;

    void client
      .getFirstRunStatus()
      .then((status) => {
        if (cancelled) return;

        if (!status.cloudProvisioned) {
          return;
        }

        if (needsBootstrapSession()) {
          setShowBootstrap(true);
          return;
        }

        setState("firstRunComplete", true);
        coordinatorDispatchRef.current({
          type: "FIRST_RUN_COMPLETE",
          target: "cloud-managed",
        });
      })
      .catch(() => {
        cloudSkipProbeStartedRef.current = false;
      });

    return () => {
      cancelled = true;
    };
  }, [phase, setState]);

  const handleBootstrapAdvance = useCallback(() => {
    setShowBootstrap(false);
    setState("firstRunComplete", true);
    coordinatorDispatchRef.current({
      type: "FIRST_RUN_COMPLETE",
      target: "cloud-managed",
    });
  }, [setState]);

  let startupErrorState: StartupErrorState | null = null;
  if (phase === "error") {
    const coordState = startupCoordinator.state;
    const errState =
      coordState.phase === "error" &&
      typeof coordState.reason === "string" &&
      typeof coordState.message === "string"
        ? {
            reason: coordState.reason as StartupErrorReason,
            message: coordState.message,
          }
        : null;
    startupErrorState = startupError ?? {
      reason: errState?.reason ?? "unknown",
      message:
        errState?.message ?? "An unexpected error occurred during startup.",
      phase: "starting-backend",
    };
  }

  const bootstrapRequired =
    phase === "first-run-required" &&
    (showBootstrap ||
      (firstRunCloudProvisionedContainer && needsBootstrapSession()));
  const showFirstRun =
    (phase === "first-run-required" && !bootstrapRequired) ||
    (phase === "ready" && !firstRunComplete);

  let view: StartupShellView;
  if (startupErrorState) {
    view = { kind: "error", error: startupErrorState };
  } else if (phase === "pairing-required") {
    view = { kind: "pairing" };
  } else if (bootstrapRequired) {
    view = { kind: "bootstrap", onAdvance: handleBootstrapAdvance };
  } else if (showFirstRun) {
    view = { kind: "first-run" };
  } else if (phase === "ready") {
    view = { kind: "none" };
  } else {
    view = {
      kind: "loading",
      phase,
      status: t(phaseToStatusKey(phase)),
    };
  }

  return {
    view,
    retryStartup,
  };
}
