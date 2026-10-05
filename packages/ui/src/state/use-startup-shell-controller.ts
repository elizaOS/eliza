/**
 * Drives the startup-shell state machine: waits for the local/remote agent,
 * adopts remote first-run, applies connect deep-links, and surfaces startup
 * errors. Distinguishes the benign loopback-gateway target from a repoint to a
 * different server that needs confirmation.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../api/client";
import type { StartupShellView } from "../components/shell/startup-shell-types";
import { ensureStoreBuildWorkspaceFolder } from "../first-run/ensure-store-build-workspace-folder";
import { useAppSelectorShallow } from "./app-store";
import { runStartupProbe } from "./startup-probe";
import type { StartupErrorReason, StartupErrorState } from "./types";
import { useRemoteConnectRequests } from "./use-remote-connect-requests";

function needsBootstrapSession(): boolean {
  try {
    return !sessionStorage.getItem("eliza_session");
  } catch {
    // error-policy:J3 sessionStorage may be unavailable (privacy mode / disabled
    // storage); assume a bootstrap session is needed — the safe branch that runs
    // setup rather than skipping it on an unreadable store.
    return true;
  }
}

/**
 * Whether the cloud-container bootstrap gate must hold the full-screen
 * StartupScreen even though `first-run-required` is otherwise shell-paintable
 * (in-chat onboarding). App.tsx consults this at its paintability gate — the
 * controller computes the same condition into `view: { kind: "bootstrap" }`,
 * but the view is only rendered where StartupScreen is mounted.
 */
export function isBootstrapGateRequired(
  phase: string,
  firstRunCloudProvisionedContainer: boolean,
): boolean {
  return (
    phase === "first-run-required" &&
    firstRunCloudProvisionedContainer &&
    needsBootstrapSession()
  );
}

export interface StartupShellController {
  view: StartupShellView;
  retryStartup: () => void;
}

export function useStartupShellController(): StartupShellController {
  // Granular shallow selector instead of useApp() so the startup controller
  // re-renders only when one of the seven fields it reads changes, not on every
  // app-store field update (#9141 gap 2 — useApp() → useAppSelector migration).
  const {
    startupCoordinator,
    startupError,
    firstRunCloudProvisionedContainer,
    retryStartup,
    setState,
    t,
  } = useAppSelectorShallow((s) => ({
    startupCoordinator: s.startupCoordinator,
    startupError: s.startupError,
    firstRunCloudProvisionedContainer: s.firstRunCloudProvisionedContainer,
    retryStartup: s.retryStartup,
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

  useRemoteConnectRequests();

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

    // The auth-status probe is the authority for whether a provisioned cloud
    // container needs its one-time bootstrap session. Its first-run endpoint is
    // protected until that session exists, so probing it here would turn the
    // expected 401 into a startup failure before the bootstrap screen can run.
    if (isBootstrapGateRequired(phase, firstRunCloudProvisionedContainer)) {
      setShowBootstrap(true);
      return;
    }

    cloudSkipProbeStartedRef.current = true;
    let cancelled = false;

    void runStartupProbe(() => client.getFirstRunStatus()).then((probe) => {
      if (cancelled) return;

      if (probe.kind !== "ok") {
        coordinatorDispatchRef.current({
          type: "AGENT_ERROR",
          message:
            probe.error instanceof Error
              ? probe.error.message
              : "Could not verify the agent setup state.",
        });
        return;
      }

      const status = probe.value;

      if (!status.cloudProvisioned) {
        return;
      }

      setState("firstRunComplete", true);
      coordinatorDispatchRef.current({ type: "FIRST_RUN_COMPLETE" });
    });

    return () => {
      cancelled = true;
    };
  }, [firstRunCloudProvisionedContainer, phase, setState]);

  const handleBootstrapAdvance = useCallback(() => {
    setShowBootstrap(false);
    retryStartup();
  }, [retryStartup]);

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

  // Onboarding now happens IN the live chat (homescreen + auto-opened
  // ChatOverlay seeded by the headless first-run conductor), so the
  // controller no longer forces a full-screen `first-run` view. For
  // first-run-required (non-bootstrap) we yield `{ kind: "none" }` — the shell
  // is painted by App.tsx (isShellPaintable now true for first-run-required)
  // and any stray StartupScreen mount stays inert.
  let view: StartupShellView;
  if (startupErrorState) {
    view = { kind: "error", error: startupErrorState };
  } else if (phase === "pairing-required") {
    view = { kind: "pairing" };
  } else if (bootstrapRequired) {
    view = { kind: "bootstrap", onAdvance: handleBootstrapAdvance };
  } else if (phase === "ready" || phase === "first-run-required") {
    view = { kind: "none" };
  } else {
    view = {
      kind: "loading",
      phase,
      status: t(startupCoordinator.statusMessageKey),
    };
  }

  return {
    view,
    retryStartup,
  };
}
