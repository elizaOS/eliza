/**
 * StartupShell — the front door to the app.
 *
 * Shows a branded splash with retro progress bar during ALL startup phases.
 * New users see the server chooser first. Returning users see the progress bar
 * immediately. The splash stays visible until the app is FULLY loaded
 * (including a brief settle delay after coordinator reaches ready).
 *
 * Non-loading phases (error, pairing, onboarding) delegate to their views.
 */

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { client } from "../../api";
import { CONNECT_EVENT } from "../../events";
import { persistMobileRuntimeModeForServerTarget } from "../../onboarding/mobile-runtime-mode";
import { applyLaunchConnection } from "../../platform";
import { useApp } from "../../state";
import type { StartupErrorReason, StartupErrorState } from "../../state/types";
import { resolveAppAssetUrl } from "../../utils";
import { BootstrapStep } from "../onboarding/BootstrapStep";
import { PairingView } from "./PairingView";
import { RuntimeGate } from "./RuntimeGate";
import { StartupFailureView } from "./StartupFailureView";

const FONT = "'Courier New', 'Courier', 'Monaco', monospace";

const PHASE_PROGRESS: Record<string, number> = {
  splash: 0,
  "restoring-session": 10,
  "resolving-target": 20,
  "polling-backend": 40,
  "starting-runtime": 60,
  hydrating: 85,
  ready: 100,
};

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

/**
 * Returns true when the cloud-provisioned bootstrap session has NOT yet been
 * established for this page load. After a successful exchange the UI writes
 * sessionStorage["eliza_session"] as a renderer-side marker; the server-owned
 * HttpOnly cookie remains the actual auth boundary.
 */
function needsBootstrapSession(): boolean {
  try {
    return !sessionStorage.getItem("eliza_session");
  } catch {
    // sessionStorage unavailable — treat as needing bootstrap (fail closed).
    return true;
  }
}

export function StartupShell() {
  const {
    startupCoordinator,
    startupError,
    onboardingComplete,
    onboardingCloudProvisionedContainer,
    retryStartup,
    setActionNotice,
    setState,
    t,
  } = useApp();
  const phase = startupCoordinator.phase;
  const cloudSkipProbeStartedRef = useRef(false);
  const isSplash = phase === "splash";
  const splashLoaded = isSplash
    ? (startupCoordinator.state as { loaded?: boolean }).loaded
    : false;
  const progress = PHASE_PROGRESS[phase] ?? 50;

  // ── Bootstrap gate state ───────────────────────────────────────
  // Set to true when the server reports cloudProvisioned=true and no
  // session exists yet. Set to false once the bootstrap exchange succeeds
  // (onAdvance callback below).
  const [showBootstrap, setShowBootstrap] = useState(false);

  // ── Cloud onboarding skip ──────────────────────────────────────
  // Fallback: if a cloud-provisioned container still reaches onboarding-required
  // (e.g. splash probe didn't fire SPLASH_CLOUD_SKIP), re-check the server here
  // and fast-forward past onboarding.
  //
  // IMPORTANT: deps must NOT include the unstable `startupCoordinator` object
  // reference. Including it caused the probe to be cancelled on every re-render
  // (RuntimeGate triggers state updates when the cloud login resolves), killing
  // the in-flight fetch. We use a ref to access the coordinator's dispatch
  // function instead.
  const coordinatorDispatchRef = useRef(startupCoordinator.dispatch);
  coordinatorDispatchRef.current = startupCoordinator.dispatch;
  const coordinatorStateRef = useRef(startupCoordinator.state);
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
        });
        persistMobileRuntimeModeForServerTarget("remote");
        setState("onboardingServerTarget", "remote");
        setState("onboardingRemoteApiBase", connection.apiBase);
        setState("onboardingRemoteToken", connection.token ?? "");
        setState("onboardingRemoteConnected", true);
        setState("onboardingRemoteError", null);
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
    if (phase !== "onboarding-required") {
      cloudSkipProbeStartedRef.current = false;
      return;
    }

    const coordState = coordinatorStateRef.current;
    if (
      coordState.phase !== "onboarding-required" ||
      coordState.serverReachable ||
      cloudSkipProbeStartedRef.current
    ) {
      return;
    }

    cloudSkipProbeStartedRef.current = true;
    let cancelled = false;

    void client
      .getOnboardingStatus()
      .then((status) => {
        if (cancelled) return;

        if (!status.cloudProvisioned) {
          // Not a cloud-provisioned container — nothing special to do here.
          return;
        }

        if (needsBootstrapSession()) {
          // Cloud-provisioned but no session yet. Lock the dashboard and show
          // the bootstrap wizard step. Fail closed: we do NOT advance.
          setShowBootstrap(true);
          return;
        }

        // Cloud-provisioned and session already established — skip the wizard.
        setState("onboardingComplete", true);
        coordinatorDispatchRef.current({ type: "ONBOARDING_COMPLETE" });
      })
      .catch(() => {
        // Probe failed — fail closed. If we can't determine cloud status,
        // keep showBootstrap as false (no special gate) so the user sees
        // RuntimeGate and can still choose how to connect.
        cloudSkipProbeStartedRef.current = false;
      });

    return () => {
      cancelled = true;
    };
  }, [phase, setState]);

  // ── Bootstrap advance ──────────────────────────────────────────
  // Called by BootstrapStep after a successful exchange. The session is
  // already in sessionStorage at this point. Dispatch ONBOARDING_COMPLETE
  // so the coordinator moves to "ready" and the main app shell renders.
  const handleBootstrapAdvance = useCallback(() => {
    setShowBootstrap(false);
    setState("onboardingComplete", true);
    coordinatorDispatchRef.current({ type: "ONBOARDING_COMPLETE" });
  }, [setState]);

  // ── Auto-continue splash ──────────────────────────────────────
  // The deployment chooser now lives inside RuntimeGate. The splash phase
  // is a pure loading screen that auto-advances to onboarding-required,
  // which renders RuntimeGate when the user hasn't been onboarded yet.
  useEffect(() => {
    if (isSplash && splashLoaded) {
      startupCoordinator.dispatch({ type: "SPLASH_CONTINUE" });
    }
  }, [isSplash, splashLoaded, startupCoordinator]);

  // Error — delegate
  if (phase === "error") {
    const coordState = startupCoordinator.state;
    const errState =
      coordState.phase === "error" &&
      typeof coordState.reason === "string" &&
      typeof coordState.message === "string"
        ? {
            reason: coordState.reason as StartupErrorReason,
            message: coordState.message,
            timedOut: coordState.timedOut === true,
          }
        : null;
    const errorState: StartupErrorState = startupError ?? {
      reason: errState?.reason ?? "unknown",
      message:
        errState?.message ?? "An unexpected error occurred during startup.",
      phase: "starting-backend" as const,
    };
    return <StartupFailureView error={errorState} onRetry={retryStartup} />;
  }

  // Pairing — delegate
  if (phase === "pairing-required") {
    return <PairingView />;
  }

  // Onboarding — cloud-provisioned containers must exchange their bootstrap
  // token before reaching RuntimeGate. All other containers go straight through.
  if (phase === "onboarding-required") {
    if (
      showBootstrap ||
      (onboardingCloudProvisionedContainer && needsBootstrapSession())
    ) {
      return (
        <BootstrapGateShell>
          <BootstrapStep onAdvance={handleBootstrapAdvance} />
        </BootstrapGateShell>
      );
    }
    return <RuntimeGate />;
  }

  // Ready — let the app through
  if (phase === "ready") {
    if (!onboardingComplete) {
      return <RuntimeGate />;
    }
    return null;
  }

  return (
    <div
      data-testid="startup-shell-loading"
      data-startup-phase={phase}
      className="flex items-center justify-center h-full w-full bg-[#ffe600] text-black overflow-hidden"
    >
      <img
        src={resolveAppAssetUrl("splash-bg.png")}
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full object-cover"
      />
      <div
        className="relative z-10 flex flex-col items-center gap-5 px-6 text-center w-full"
        style={{ maxWidth: 360 }}
      >
        {/* Retro segmented progress bar — splash auto-continues to onboarding */}
        <div className="w-full mt-2">
          <div className="h-5 w-full border-2 border-black/70 bg-black/5 overflow-hidden">
            <div
              className="h-full bg-black/70 transition-all duration-700 ease-out"
              style={{ width: `${progress}%` }}
            >
              <div
                className="h-full w-full"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(90deg, transparent, transparent 6px, rgba(255,230,0,0.5) 6px, rgba(255,230,0,0.5) 8px)",
                }}
              />
            </div>
          </div>
          <p
            style={{ fontFamily: FONT }}
            className="mt-2 text-3xs text-black/50 uppercase animate-pulse"
          >
            {t(phaseToStatusKey(phase))}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Shell wrapper for the bootstrap step — matches the dark visual style of
 * RuntimeGate so the bootstrap gate feels like part of the same flow.
 */
function BootstrapGateShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-full w-full flex-col bg-black text-white">
      <div
        aria-hidden="true"
        className="absolute inset-0 overflow-hidden pointer-events-none"
      >
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.14),transparent_36%),linear-gradient(180deg,rgba(11,14,20,0.18),rgba(6,7,8,0.56))]" />
        <div className="absolute left-[-10%] top-[8%] h-[24rem] w-[24rem] rounded-full bg-[rgba(240,185,11,0.1)] blur-[110px]" />
        <div className="absolute bottom-[-12%] right-[-8%] h-[20rem] w-[20rem] rounded-full bg-[rgba(255,255,255,0.08)] blur-[120px]" />
      </div>
      <div className="relative z-10 flex flex-1 items-center justify-center px-4 pb-[max(1.5rem,var(--safe-area-bottom,0px))] pt-[calc(var(--safe-area-top,0px)_+_3.75rem)] sm:px-6 md:px-8">
        <div className="flex w-full max-w-[32rem] flex-col items-center gap-4">
          {children}
        </div>
      </div>
    </div>
  );
}
