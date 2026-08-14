/**
 * Post-login landing that opens the account-native personal Eliza in chat.
 *
 * After Steward login the page resolves the account-native rowless Shared
 * Eliza, persists its Cloud binding, then hard-navigates to chat. A full
 * navigation lets startup restore the new binding from a clean boot.
 *
 * Signed-out app-host visitors first restore a live apex session through the
 * PKCE SSO bridge, or fall back to `/login?returnTo=/join` when no apex session
 * marker exists. This keeps the same URL safe for marketing and email links.
 *
 * Web-build-only (mounted by the cloud router shell); never loaded by the native
 * tab/view app directly.
 */

import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared/brand";
import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { client } from "../../api/client";
import { Button } from "../../components/ui/button";
import {
  savePersistedActiveServer,
  savePersistedFirstRunComplete,
} from "../../state/persistence";
import { appModeNavigation } from "../app-mode/app-mode";
import { useCloudT } from "../shell/CloudI18nProvider";
import {
  clearSsoLoggedOut,
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

type JoinPhase = "connecting" | "ready" | "error";

function describeJoinError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  return "Could not connect to your agent. Try again.";
}

export default function JoinPage(): React.JSX.Element {
  const t = useCloudT();
  const session = useJoinSessionAuth();
  const [phase, setPhase] = useState<JoinPhase>("connecting");
  const [detail, setDetail] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
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
  } | null>(null);

  const start = useCallback(async () => {
    const authToken = resolveJoinAuthToken();
    if (!authToken) {
      // No session — the auth gate below redirects to login; bail quietly.
      return;
    }
    setPhase("connecting");
    setError(null);
    activeAttemptRef.current?.controller.abort(
      new DOMException("Join attempt superseded", "AbortError"),
    );
    const controller = new AbortController();
    const attempt = (async () => {
      try {
        const result = await runJoinFlow({
          client,
          effects: {
            savePersistedActiveServer,
            savePersistedFirstRunComplete,
          },
          cloudApiBase: resolveJoinCloudApiBase(),
          authToken,
          signal: controller.signal,
          onProgress: (_status, progressDetail) => {
            if (progressDetail) setDetail(progressDetail);
          },
        });
        controller.signal.throwIfAborted();
        setPhase("ready");
        // Hard navigation to chat home so the startup coordinator restores the
        // just-persisted cloud connection from a clean boot. `void result` keeps
        // the resolved agent in scope for future telemetry without unused-var noise.
        void result;
        if (typeof window !== "undefined") {
          appModeNavigation.assign("/");
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(describeJoinError(err));
        setPhase("error");
      }
    })();
    activeAttemptRef.current = { controller, promise: attempt };
    await attempt;
    if (activeAttemptRef.current?.controller === controller) {
      activeAttemptRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      activeAttemptRef.current?.controller.abort(
        new DOMException("Join page unmounted", "AbortError"),
      );
    },
    [],
  );

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
    clearSsoLoggedOut();
    if (appHandoff) {
      // The apex is the billing console and cannot boot chat. Hand off before
      // any Shared identity request. Preserve /join so the app host restores
      // the domain-wide session before opening the same account-native Eliza.
      appModeNavigation.replace(appHandoff);
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [session.ready, session.authenticated, appHandoff, start]);

  const handleRetry = useCallback(() => {
    startedRef.current = true;
    void start();
  }, [start]);

  const handleSignOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    const active = activeAttemptRef.current;
    active?.controller.abort(
      new DOMException("User signed out during join", "AbortError"),
    );
    // Let the aborted identity read settle before revoking the Steward session,
    // so no stale completion can bind or persist an account after sign-out.
    await active?.promise.catch(() => undefined);
    const { signOutFromSsoBridgedHost } = await import(
      "../sso-bridge/sso-bridge"
    );
    await signOutFromSsoBridgedHost();
    appModeNavigation.replace("/login");
  }, [signingOut]);

  // Signed out → send to login, returning here once authenticated.
  if (session.ready && !session.authenticated && ssoBridging === false) {
    return <Navigate to="/login?returnTo=/join" replace />;
  }

  return (
    <div
      className="theme-cloud flex min-h-screen w-full flex-col items-center justify-center bg-black px-4 text-white"
      style={{ background: "var(--background)" }}
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <img
          src={`${BRAND_PATHS.logos}/${LOGO_FILES.cloudWhite}`}
          alt="Eliza Cloud"
          className="h-8 w-auto"
          draggable={false}
        />

        {phase === "error" ? (
          <div className="flex flex-col items-center gap-4">
            <h1 className="font-poppins text-lg font-semibold text-white">
              {t("cloud.join.errorTitle", {
                defaultValue: "Couldn't open your Eliza",
              })}
            </h1>
            <p className="text-sm text-white/70">
              {error ??
                t("cloud.join.errorBody", {
                  defaultValue: "Something went wrong. Try again.",
                })}
            </p>
            <Button
              variant="ghost"
              type="button"
              onClick={handleRetry}
              className="bg-txt px-6 py-2.5 font-semibold text-bg transition-colors hover:bg-txt/90"
            >
              {t("cloud.join.retry", { defaultValue: "Try again" })}
            </Button>
            <Button
              variant="ghost"
              type="button"
              disabled={signingOut}
              onClick={() => void handleSignOut()}
              className="px-6 py-2 text-sm text-white/70 transition-colors hover:text-white"
            >
              {signingOut
                ? t("cloud.join.signingOut", { defaultValue: "Signing out..." })
                : t("cloud.join.signOut", { defaultValue: "Sign out" })}
            </Button>
          </div>
        ) : (
          <div
            className="flex flex-col items-center gap-4"
            role="status"
            aria-busy="true"
          >
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/80 border-t-transparent" />
            <p className="text-sm text-white/72">
              {detail ||
                t("cloud.join.connecting", {
                  defaultValue: "Opening your personal Eliza...",
                })}
            </p>
            <Button
              variant="ghost"
              type="button"
              disabled={signingOut}
              onClick={() => void handleSignOut()}
              className="px-6 py-2 text-sm text-white/70 transition-colors hover:text-white"
            >
              {signingOut
                ? t("cloud.join.signingOut", { defaultValue: "Signing out..." })
                : t("cloud.join.signOut", { defaultValue: "Sign out" })}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
