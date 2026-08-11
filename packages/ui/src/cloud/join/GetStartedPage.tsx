/**
 * `/get-started` on the cloud app hosts — the messaging → cloud signup
 * continuation landing.
 *
 * A messaging onboarding funnel (Discord DM today) hands the browser
 * `?onboardingSession=<opaque token>`. This page persists the token across the
 * Steward login round trip, then redeems it server-side with the Steward
 * bearer: the onboarding chat endpoint binds the session to the account, links
 * the gateway-attested platform identity (e.g. discord_id, so DMs route to the
 * provisioned agent instead of onboarding forever), and starts provisioning.
 * On success the user is told to head back to their DM, with a button into the
 * in-app chat (`/join`) as the alternative.
 *
 * Signed-out visitors bounce to `/login?returnTo=/get-started`; the token
 * survives in storage, not the URL. A visit with no pending token just
 * forwards to `/join` — the page is harmless as a bare deep link.
 */

import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared/brand";
import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { Button } from "../../components/ui/button";
import { useCloudT } from "../shell/CloudI18nProvider";
import {
  completePendingOnboardingContinuation,
  peekPendingOnboardingSession,
  previewPendingOnboardingContinuation,
  sanitizeOnboardingSessionToken,
  storePendingOnboardingSession,
} from "./lib/onboarding-continuation";
import { useJoinSessionAuth } from "./lib/use-join-session";

type GetStartedPhase = "checking" | "confirm" | "linking" | "done" | "error";

function describeContinuationError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  return "Could not finish connecting your account. Try again.";
}

export default function GetStartedPage(): React.JSX.Element {
  const t = useCloudT();
  const session = useJoinSessionAuth();
  const [searchParams] = useSearchParams();
  const [phase, setPhase] = useState<GetStartedPhase>("checking");
  const [error, setError] = useState<string | null>(null);
  const [discordIdentity, setDiscordIdentity] = useState<{
    platformUserId: string;
    platformDisplayName: string;
  } | null>(null);
  // StrictMode double-mount guard: the redemption POST must run once.
  const startedRef = useRef(false);

  // Ingest the URL credential exactly once. The state initializer persists it
  // before a login redirect can drop the query string, then removes it from the
  // address bar so a remount cannot resurrect a successfully consumed token.
  const [urlToken] = useState(() => {
    const token = sanitizeOnboardingSessionToken(
      searchParams.get("onboardingSession"),
    );
    if (!token) return null;

    storePendingOnboardingSession(token);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete("onboardingSession");
    window.history.replaceState(
      window.history.state,
      "",
      `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
    );
    return token;
  });

  const pendingToken = urlToken ?? peekPendingOnboardingSession();

  // Stable identity (no deps): the effect below keys on session readiness
  // only, so a re-render can never re-trigger — or abort — an in-flight
  // redemption POST (the #695 useEffect-deps failure mode).
  const redeem = useCallback(async (token: string) => {
    setPhase("linking");
    setError(null);
    try {
      await completePendingOnboardingContinuation(token);
      setPhase("done");
    } catch (err) {
      setError(describeContinuationError(err));
      setPhase("error");
    }
  }, []);

  // Preview failures must retry the read-only preview, never jump directly to
  // the mutating redemption with confirmPlatformLink=true. Otherwise a
  // transient preview failure would turn the generic Retry button into an
  // uninformed identity-link confirmation (the confused-deputy path this page
  // exists to prevent).
  const preview = useCallback(async (token: string) => {
    setPhase("checking");
    setError(null);
    try {
      const identity = await previewPendingOnboardingContinuation(token);
      setDiscordIdentity(identity);
      setPhase("confirm");
    } catch (err) {
      setError(describeContinuationError(err));
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    if (!session.ready || !session.authenticated) return;
    if (startedRef.current) return;
    const token = peekPendingOnboardingSession();
    if (!token) return;
    startedRef.current = true;
    void preview(token);
  }, [session.ready, session.authenticated, preview]);

  if (session.ready && !session.authenticated) {
    // The token is already persisted in storage; the URL param never needs to
    // survive the login round trip.
    return <Navigate to="/login?returnTo=/get-started" replace />;
  }

  if (session.ready && session.authenticated && !pendingToken) {
    // Nothing to redeem — treat as a plain post-login entry.
    return <Navigate to="/join" replace />;
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

        {phase === "confirm" && discordIdentity ? (
          <div className="flex flex-col items-center gap-4">
            <h1 className="font-poppins text-lg font-semibold text-white">
              Connect your Discord account?
            </h1>
            <p className="text-sm text-white/70">
              Continue with{" "}
              <strong>{discordIdentity.platformDisplayName}</strong>
              <span className="block text-xs text-white/50">
                Discord ID {discordIdentity.platformUserId}
              </span>
            </p>
            <Button
              type="button"
              onClick={() => {
                const token = peekPendingOnboardingSession();
                if (token) void redeem(token);
              }}
              className="bg-txt px-6 py-2.5 font-semibold text-bg"
            >
              Connect this Discord account
            </Button>
          </div>
        ) : phase === "done" ? (
          <div className="flex flex-col items-center gap-4">
            <h1 className="font-poppins text-lg font-semibold text-white">
              {t("cloud.getStarted.linkedTitle", {
                defaultValue: "You're connected",
              })}
            </h1>
            <p className="text-sm text-white/70">
              {t("cloud.getStarted.linkedBody", {
                defaultValue:
                  "Head back to your chat — your agent will pick up right where you left off. Setup finishes in the background.",
              })}
            </p>
            <Button
              variant="ghost"
              type="button"
              onClick={() => window.location.assign("/join")}
              className="bg-txt px-6 py-2.5 font-semibold text-bg transition-colors hover:bg-txt/90"
            >
              {t("cloud.getStarted.openChat", {
                defaultValue: "Or chat here instead",
              })}
            </Button>
          </div>
        ) : phase === "error" ? (
          <div className="flex flex-col items-center gap-4">
            <h1 className="font-poppins text-lg font-semibold text-white">
              {t("cloud.getStarted.errorTitle", {
                defaultValue: "Couldn't connect your account",
              })}
            </h1>
            <p className="text-sm text-white/70">{error}</p>
            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                const token = peekPendingOnboardingSession();
                if (!token) return;
                if (discordIdentity) void redeem(token);
                else void preview(token);
              }}
              className="bg-txt px-6 py-2.5 font-semibold text-bg transition-colors hover:bg-txt/90"
            >
              {t("cloud.getStarted.retry", { defaultValue: "Try again" })}
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
              {t("cloud.getStarted.linking", {
                defaultValue:
                  phase === "checking"
                    ? "Checking your connection..."
                    : "Connecting your account...",
              })}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
