import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../api";
import type { StartupShellView } from "../components/shell/startup-shell-types";
import { CONNECT_EVENT } from "../events";
import { ensureStoreBuildWorkspaceFolder } from "../first-run/ensure-store-build-workspace-folder";
import { persistMobileRuntimeModeForServerTarget } from "../first-run/mobile-runtime-mode";
import { applyLaunchConnection } from "../platform";
import { confirmDesktopAction } from "../utils/desktop-dialogs";
import { useAppSelectorShallow } from "./app-store";
import type { StartupErrorReason, StartupErrorState } from "./types";

/**
 * A loopback gateway is the local-agent-on-this-machine case — the common,
 * benign target a `connect` deep link points at. Anything else (LAN, Tailscale,
 * .local, a public host) repoints the app at a different server and must be
 * user-confirmed (see the CONNECT_EVENT handler).
 */
export function isLoopbackGatewayHost(gatewayUrl: string): boolean {
  try {
    const host = new URL(gatewayUrl).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "");
    return (
      host === "localhost" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host.startsWith("127.")
    );
  } catch {
    return false;
  }
}

function gatewayHostForDisplay(gatewayUrl: string): string {
  try {
    return new URL(gatewayUrl).host || gatewayUrl;
  } catch {
    return gatewayUrl;
  }
}

function phaseToStatusKey(phase: string): string {
  switch (phase) {
    case "restoring-session":
      return "startupshell.Starting";
    case "resolving-target":
    case "polling-backend":
      // Generic boot message — the user shouldn't see a backend-specific status
      // (the agent can be local, remote, or cloud). Reuses the already-localized
      // generic "Booting up…" key rather than "Connecting to backend…".
      return "startupshell.Starting";
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
  // Granular shallow selector instead of useApp() so the startup controller
  // re-renders only when one of the eight fields it reads changes, not on every
  // app-store field update (#9141 gap 2 — useApp() → useAppSelector migration).
  const {
    startupCoordinator,
    startupError,
    firstRunComplete,
    firstRunCloudProvisionedContainer,
    retryStartup,
    setActionNotice,
    setState,
    t,
  } = useAppSelectorShallow((s) => ({
    startupCoordinator: s.startupCoordinator,
    startupError: s.startupError,
    firstRunComplete: s.firstRunComplete,
    firstRunCloudProvisionedContainer: s.firstRunCloudProvisionedContainer,
    retryStartup: s.retryStartup,
    setActionNotice: s.setActionNotice,
    setState: s.setState,
    t: s.t,
  }));
  const phase = startupCoordinator.phase;
  const [showBootstrap, setShowBootstrap] = useState(false);
  const cloudSkipProbeStartedRef = useRef(false);
  const coordinatorDispatchRef = useRef(startupCoordinator.dispatch);
  const coordinatorStateRef = useRef(startupCoordinator.state);

  coordinatorDispatchRef.current = startupCoordinator.dispatch;
  coordinatorStateRef.current = startupCoordinator.state;

  useEffect(() => {
    const handleConnect = async (event: Event): Promise<void> => {
      const detail = (event as CustomEvent<unknown>).detail;
      const payload =
        detail && typeof detail === "object" && !Array.isArray(detail)
          ? (detail as { gatewayUrl?: unknown; token?: unknown })
          : null;
      if (typeof payload?.gatewayUrl !== "string") {
        return;
      }

      // CONNECT_EVENT is only ever dispatched from an OS-delivered `connect`
      // deep link (attacker-reachable). Repointing the agent API base to a
      // non-loopback host is security-sensitive, so require explicit user
      // confirmation for any remote target; the local-agent (loopback) connect
      // stays frictionless.
      if (!isLoopbackGatewayHost(payload.gatewayUrl)) {
        const approved = await confirmDesktopAction({
          type: "warning",
          title: "Connect to this server?",
          message: `Point this app at "${gatewayHostForDisplay(payload.gatewayUrl)}"?`,
          detail:
            "A link asked to connect this app to a different agent server. Only continue if you trust it — that server will handle your messages and data.",
          confirmLabel: "Connect",
          cancelLabel: "Cancel",
        });
        if (!approved) {
          setActionNotice("Connection request cancelled.", "info", 4200);
          return;
        }
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
      !firstRunCloudProvisionedContainer ||
      !coordState.serverReachable ||
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
        coordinatorDispatchRef.current({ type: "FIRST_RUN_COMPLETE" });
      })
      .catch(() => {
        cloudSkipProbeStartedRef.current = false;
      });

    return () => {
      cancelled = true;
    };
  }, [firstRunCloudProvisionedContainer, phase, setState]);

  const handleBootstrapAdvance = useCallback(() => {
    setShowBootstrap(false);
    setState("firstRunComplete", true);
    coordinatorDispatchRef.current({ type: "FIRST_RUN_COMPLETE" });
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
