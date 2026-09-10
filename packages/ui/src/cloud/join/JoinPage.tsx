/**
 * Post-login landing that opens the account-native personal Eliza in chat.
 *
 * After Steward login the page resolves the existing Shared or Dedicated
 * binding, persists it, then transitions to chat in the current document.
 * Entry never starts or adopts paid compute; optional hosting changes belong
 * to the separate explicit-consent flow.
 *
 * Signed-out app-host visitors first restore a live apex session through the
 * PKCE SSO bridge, or fall back to `/login?returnTo=/join` when no apex session
 * marker exists. This keeps the same URL safe for marketing and email links.
 *
 * Web-build-only (mounted by the cloud router shell); never loaded by the native
 * tab/view app directly.
 */

import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared/brand";
import {
  getStewardTabSessionAuthorityCoordinator,
  STEWARD_SESSION_CHANGE_EVENT,
  StewardSessionAuthorityError,
} from "@elizaos/shared/steward-session-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { client } from "../../api";
import { Button } from "../../components/ui/button";
import {
  savePersistedActiveServer,
  savePersistedFirstRunComplete,
} from "../../state/persistence";
import { appModeNavigation } from "../app-mode/app-mode";
import { publishPersonalEntryHandoff } from "../app-mode/use-personal-entry";
import { openCloudBillingConsole } from "../billing-console";
import { useCloudT } from "../shell/CloudI18nProvider";
import {
  redirectToSsoBridge,
  shouldAutoBridgeToSso,
} from "../sso-bridge/sso-bridge";
import { resolveApexJoinHandoff } from "./lib/apex-app-handoff";
import {
  resolveJoinAuthToken,
  resolveJoinCloudApiBase,
} from "./lib/resolve-cloud-connection";
import { runJoinFlow } from "./lib/run-join-flow";
import { useJoinSessionAuth } from "./lib/use-join-session";

type JoinPhase = "connecting" | "ready" | "error" | "sign-out-error";

type JoinFailure =
  | { kind: "insufficient-credit"; message: string }
  | { kind: "generic"; message: string };

function describeJoinError(err: unknown): JoinFailure {
  const message =
    err instanceof Error && err.message.trim()
      ? err.message
      : "Could not connect to your agent. Try again.";
  if (err instanceof Error && "status" in err && err.status === 402) {
    return { kind: "insufficient-credit", message };
  }
  return { kind: "generic", message };
}

export default function JoinPage(): React.JSX.Element {
  const t = useCloudT();
  const session = useJoinSessionAuth();
  const entryState: unknown = useLocation().state;
  const requiresRetry =
    typeof entryState === "object" &&
    entryState !== null &&
    "personalEntryInvalidated" in entryState &&
    entryState.personalEntryInvalidated === true;
  const [phase, setPhase] = useState<JoinPhase>("connecting");
  const [detail, setDetail] = useState<string>("");
  const [error, setError] = useState<JoinFailure | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [openingBilling, setOpeningBilling] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);
  const billingOpeningRef = useRef(false);
  const appHandoff =
    typeof window === "undefined"
      ? null
      : resolveApexJoinHandoff(window.location.hostname);
  const ssoDecisionRef = useRef(false);
  const [ssoBridging, setSsoBridging] = useState<boolean | null>(null);
  // Guard so React StrictMode's double-mount does not duplicate identity reads.
  const startedRef = useRef(false);
  const activeAttemptRef = useRef<{
    controller: AbortController;
    promise: Promise<void>;
    revalidate: () => void;
  } | null>(null);

  const start = useCallback(async () => {
    const authToken = resolveJoinAuthToken();
    if (!authToken) {
      // No session — the auth gate below redirects to login; bail quietly.
      return;
    }
    setPhase("connecting");
    setError(null);
    setBillingError(null);
    activeAttemptRef.current?.controller.abort(
      new DOMException("Join attempt superseded", "AbortError"),
    );
    const controller = new AbortController();
    let revalidate = () => controller.signal.throwIfAborted();
    const attempt = (async () => {
      try {
        const coordinator = getStewardTabSessionAuthorityCoordinator();
        const snapshot = coordinator.readSnapshot();
        const cloudApiBase = resolveJoinCloudApiBase();
        revalidate = () => {
          controller.signal.throwIfAborted();
          coordinator.assertSnapshot(snapshot);
          if (
            resolveJoinAuthToken() !== authToken ||
            resolveJoinCloudApiBase() !== cloudApiBase
          ) {
            throw new StewardSessionAuthorityError(
              "Your connection changed. Try again to open your Eliza.",
              "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
            );
          }
        };
        const result = await runJoinFlow({
          client,
          effects: {
            savePersistedActiveServer,
            savePersistedFirstRunComplete,
          },
          cloudApiBase,
          authToken,
          signal: controller.signal,
          revalidate,
          onProgress: (_status, progressDetail) => {
            revalidate();
            if (progressDetail) setDetail(progressDetail);
          },
        });
        revalidate();
        publishPersonalEntryHandoff(authToken, result);
        setPhase("ready");
        // The flow has configured the in-memory client and persisted the exact
        // binding. Its session-bound handoff receipt lets app-mode consume the
        // same authoritative result without a duplicate identity request.
      } catch (err) {
        // error-policy:J4 invalidated or failed entry remains explicitly retryable.
        if (controller.signal.aborted) return;
        setError(describeJoinError(err));
        setPhase("error");
      }
    })();
    activeAttemptRef.current = {
      controller,
      promise: attempt,
      revalidate: () => revalidate(),
    };
    await attempt;
    if (activeAttemptRef.current?.controller === controller) {
      activeAttemptRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      // React StrictMode performs a development-only setup → cleanup → setup
      // cycle while preserving refs. Reset the launch guard before aborting so
      // the second setup can replace the intentionally cancelled request.
      // On a real unmount there is no second setup, so this remains inert.
      startedRef.current = false;
      activeAttemptRef.current?.controller.abort(
        new DOMException("Join page unmounted", "AbortError"),
      );
    },
    [],
  );

  useEffect(() => {
    const invalidate = () => {
      const active = activeAttemptRef.current;
      if (!active || active.controller.signal.aborted) return;
      active.controller.abort(
        new DOMException("Join context changed", "AbortError"),
      );
      setError({
        kind: "generic",
        message: t("cloud.join.entryChanged", {
          defaultValue:
            "Your connection changed. Try again to open your Eliza.",
        }),
      });
      setPhase("error");
    };
    const checkSession = () => {
      try {
        activeAttemptRef.current?.revalidate();
      } catch {
        // error-policy:J4 a superseded session exposes recovery, never automatic replay.
        invalidate();
      }
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) invalidate();
    };
    window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, checkSession);
    window.addEventListener("steward-token-sync", checkSession);
    window.addEventListener("storage", checkSession);
    window.addEventListener("pagehide", invalidate);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, checkSession);
      window.removeEventListener("steward-token-sync", checkSession);
      window.removeEventListener("storage", checkSession);
      window.removeEventListener("pagehide", invalidate);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [t]);

  useEffect(() => {
    if (!session.ready) return;
    if (!session.authenticated) {
      if (ssoDecisionRef.current) return;
      ssoDecisionRef.current = true;
      if (!shouldAutoBridgeToSso()) {
        setSsoBridging(false);
        return;
      }
      void redirectToSsoBridge("/join").then((started) => {
        setSsoBridging(started);
      });
      return;
    }
    if (appHandoff) {
      // The apex is the billing console and cannot boot chat. Hand off before
      // any Shared identity request. Preserve /join so the app host restores
      // the domain-wide session before opening the same account-native Eliza.
      appModeNavigation.replace(appHandoff);
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;
    if (requiresRetry) {
      setError({
        kind: "generic",
        message: t("cloud.join.entryChanged", {
          defaultValue:
            "Your connection changed. Try again to open your Eliza.",
        }),
      });
      setPhase("error");
      return;
    }
    void start();
  }, [
    session.ready,
    session.authenticated,
    appHandoff,
    start,
    requiresRetry,
    t,
  ]);

  const handleRetry = useCallback(() => {
    startedRef.current = true;
    void start();
  }, [start]);

  const handleOpenBilling = useCallback(async () => {
    if (billingOpeningRef.current) return;
    billingOpeningRef.current = true;
    setOpeningBilling(true);
    setBillingError(null);
    const failedMessage = t("cloud.join.billingOpenFailed", {
      defaultValue: "Could not open billing. Please try again.",
    });
    try {
      if (!(await openCloudBillingConsole(resolveJoinCloudApiBase()))) {
        setBillingError(failedMessage);
      }
    } catch {
      // error-policy:J4 a platform browser launch failure keeps credit recovery available.
      setBillingError(failedMessage);
    } finally {
      billingOpeningRef.current = false;
      setOpeningBilling(false);
    }
  }, [t]);

  const handleSignOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    const active = activeAttemptRef.current;
    active?.controller.abort(
      new DOMException("User signed out during join", "AbortError"),
    );
    await active?.promise;
    const { signOutFromSsoBridgedHost } = await import(
      "../sso-bridge/sso-bridge"
    );
    try {
      await signOutFromSsoBridgedHost();
      appModeNavigation.replace("/login");
    } catch {
      // error-policy:J4 the server still owns an authenticated session, so
      // keep the user here and expose a retry instead of claiming sign-out.
      setError({
        kind: "generic",
        message: t("cloud.userMenu.signOutFailed", {
          defaultValue: "Could not sign out safely. Please try again.",
        }),
      });
      setPhase("sign-out-error");
      setSigningOut(false);
    }
  }, [signingOut, t]);

  const signOutButton = (
    <Button
      variant="ghostMuted"
      focusStyle="surface"
      size="wide"
      type="button"
      disabled={signingOut}
      onClick={() => void handleSignOut()}
    >
      {signingOut
        ? t("cloud.join.signingOut", { defaultValue: "Signing out..." })
        : t("cloud.join.signOut", { defaultValue: "Sign out" })}
    </Button>
  );

  // Signed out → send to login, returning here once authenticated.
  if (session.ready && !session.authenticated && ssoBridging === false) {
    return <Navigate to="/login?returnTo=/join" replace />;
  }

  if (phase === "ready") {
    return <Navigate to="/" replace />;
  }

  return (
    <div
      className="theme-cloud flex min-h-dvh w-full flex-col items-center justify-center bg-black px-4 text-white"
      style={{ background: "var(--background)" }}
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <img
          src={`${BRAND_PATHS.logos}/${LOGO_FILES.cloudWhite}`}
          alt="Eliza Cloud"
          className="h-8 w-auto"
          draggable={false}
        />

        {phase === "sign-out-error" ? (
          <div className="flex flex-col items-center gap-4">
            <h1 className="font-poppins text-lg font-semibold text-white">
              {t("cloud.join.signOutErrorTitle", {
                defaultValue: "Couldn't sign out",
              })}
            </h1>
            <p className="text-sm text-white/70" role="alert">
              {error?.message}
            </p>
            {signOutButton}
          </div>
        ) : phase === "error" ? (
          <div className="flex flex-col items-center gap-4">
            <h1 className="font-poppins text-lg font-semibold text-white">
              {t("cloud.join.errorTitle", {
                defaultValue: "Couldn't open your Eliza",
              })}
            </h1>
            <p className="text-sm text-white/70" role="alert">
              {error?.message ??
                t("cloud.join.errorBody", {
                  defaultValue: "Something went wrong. Try again.",
                })}
            </p>
            {error?.kind === "insufficient-credit" ? (
              <>
                <Button
                  variant="surface"
                  focusStyle="surface"
                  size="wide"
                  type="button"
                  disabled={openingBilling}
                  aria-busy={openingBilling || undefined}
                  onClick={() => void handleOpenBilling()}
                >
                  {openingBilling
                    ? t("cloud.join.openingBilling", {
                        defaultValue: "Opening billing...",
                      })
                    : t("cloud.join.addCredits", {
                        defaultValue: "Add credits",
                      })}
                </Button>
                {billingError && (
                  <p role="alert" className="text-sm text-orange-400">
                    {billingError}
                  </p>
                )}
                <Button
                  variant="ghostMuted"
                  focusStyle="surface"
                  size="wide"
                  type="button"
                  onClick={handleRetry}
                >
                  {t("cloud.join.retry", { defaultValue: "Try again" })}
                </Button>
              </>
            ) : (
              <Button
                variant="surface"
                focusStyle="surface"
                size="wide"
                type="button"
                onClick={handleRetry}
              >
                {t("cloud.join.retry", { defaultValue: "Try again" })}
              </Button>
            )}
            {signOutButton}
          </div>
        ) : (
          <div
            className="flex flex-col items-center gap-4"
            role="status"
            aria-busy="true"
          >
            <div className="size-8 animate-spin rounded-full border-2 border-white/80 border-t-transparent" />
            <p className="text-sm text-white/72">
              {detail ||
                t("cloud.join.connecting", {
                  defaultValue: "Opening your personal Eliza...",
                })}
            </p>
            {signOutButton}
          </div>
        )}
      </div>
    </div>
  );
}
