/**
 * `/get-started` on the cloud app hosts — the messaging → cloud signup
 * continuation landing.
 *
 * A messaging onboarding funnel hands the browser
 * `?onboardingSession=<opaque token>`. This page persists the token across the
 * Steward login round trip. Ordinary identity-link continuations are previewed
 * and explicitly confirmed here. Telegram account-claim continuations are
 * consumed earlier by Steward sync so the DM-created user and organization are
 * adopted before generic signup can create duplicates; after auth this page
 * simply forwards to `/join`.
 *
 * Signed-out visitors bounce to `/login?returnTo=/get-started`; the token
 * survives in storage, not the URL. A visit with no pending token just
 * forwards to `/join` — the page is harmless as a bare deep link.
 */

import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared/brand";
import { readStoredStewardToken } from "@elizaos/shared/steward-session-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { Button } from "../../components/ui/button";
import { syncStewardSessionCookie } from "../public-pages/lib/steward-session";
import { useCloudT } from "../shell/CloudI18nProvider";
import {
  completePendingOnboardingContinuation,
  type MessagingContinuationPreview,
  peekPendingOnboardingSession,
  previewPendingOnboardingContinuation,
  sanitizeOnboardingSessionToken,
  storePendingOnboardingSession,
  TELEGRAM_ACCOUNT_CLAIM_PURPOSE,
} from "./lib/onboarding-continuation";
import { useJoinSessionAuth } from "./lib/use-join-session";

type GetStartedPhase = "checking" | "confirm" | "linking" | "done" | "error";

function messagingPlatformLabel(
  platform: MessagingContinuationPreview["platform"],
): string {
  switch (platform) {
    case "discord":
      return "Discord";
    case "telegram":
      return "Telegram";
    case "blooio":
      return "iMessage";
    case "twilio":
      return "SMS";
  }
}

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
  const [platformIdentity, setPlatformIdentity] =
    useState<MessagingContinuationPreview | null>(null);
  // StrictMode double-mount guard: the redemption POST must run once.
  const startedRef = useRef(false);

  // Ingest the URL credential exactly once. The state initializer persists it
  // before a login redirect can drop the query string, then removes it from the
  // address bar so a remount cannot resurrect a successfully consumed token.
  const [urlContinuation] = useState(() => {
    const token = sanitizeOnboardingSessionToken(
      searchParams.get("onboardingSession"),
    );
    if (!token) return null;

    const purpose =
      searchParams.get("accountClaim") === "telegram"
        ? TELEGRAM_ACCOUNT_CLAIM_PURPOSE
        : "link";
    const persisted = storePendingOnboardingSession(token, purpose);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete("onboardingSession");
    nextUrl.searchParams.delete("accountClaim");
    window.history.replaceState(
      window.history.state,
      "",
      `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
    );
    return { token, purpose, persisted };
  });

  const pendingToken = urlContinuation?.token ?? peekPendingOnboardingSession();
  const telegramClaimToken =
    urlContinuation?.purpose === TELEGRAM_ACCOUNT_CLAIM_PURPOSE
      ? urlContinuation.token
      : peekPendingOnboardingSession(TELEGRAM_ACCOUNT_CLAIM_PURPOSE);
  const telegramClaimPersistenceBlocked = Boolean(
    session.ready &&
      !session.authenticated &&
      urlContinuation?.purpose === TELEGRAM_ACCOUNT_CLAIM_PURPOSE &&
      !urlContinuation.persisted,
  );

  const claimTelegramAccount = useCallback(async (continuation: string) => {
    setPhase("linking");
    setError(null);
    try {
      const stewardToken = readStoredStewardToken();
      if (!stewardToken) {
        throw new Error("Sign in again to connect this Telegram chat.");
      }
      await syncStewardSessionCookie(stewardToken, undefined, {
        telegramContinuation: continuation,
      });
      setPhase("done");
    } catch (err) {
      // error-policy:J4 claim failures remain visible and retryable; the
      // pending authority is cleared only by a successful server sync.
      setError(describeContinuationError(err));
      setPhase("error");
    }
  }, []);

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
      setPlatformIdentity(identity);
      setPhase("confirm");
    } catch (err) {
      setError(describeContinuationError(err));
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    if (!session.ready || !session.authenticated) return;
    if (startedRef.current) return;
    if (telegramClaimToken) {
      startedRef.current = true;
      void claimTelegramAccount(telegramClaimToken);
      return;
    }
    const token = peekPendingOnboardingSession();
    if (!token) return;
    startedRef.current = true;
    void preview(token);
  }, [
    session.ready,
    session.authenticated,
    telegramClaimToken,
    claimTelegramAccount,
    preview,
  ]);

  if (
    session.ready &&
    !session.authenticated &&
    !telegramClaimPersistenceBlocked
  ) {
    // The token is already persisted in storage; the URL param never needs to
    // survive the login round trip.
    return <Navigate to="/login?returnTo=/get-started" replace />;
  }

  if (session.ready && session.authenticated && !pendingToken) {
    // Nothing to redeem — treat as a plain post-login entry.
    return <Navigate to="/join" replace />;
  }

  if (phase === "done" && telegramClaimToken) {
    return <Navigate to="/join" replace />;
  }

  const renderedPhase = telegramClaimPersistenceBlocked ? "error" : phase;
  const renderedError = telegramClaimPersistenceBlocked
    ? "Allow browser storage, then try again. Your Telegram account was not changed."
    : error;

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

        {renderedPhase === "confirm" && platformIdentity ? (
          <div className="flex flex-col items-center gap-4">
            <h1 className="font-poppins text-lg font-semibold text-white">
              Connect your {messagingPlatformLabel(platformIdentity.platform)}{" "}
              account?
            </h1>
            <p className="text-sm text-white/70">
              Continue with{" "}
              <strong>{platformIdentity.platformDisplayName}</strong>
              <span className="block text-xs text-white/50">
                {platformIdentity.platform === "telegram"
                  ? "Telegram ID"
                  : platformIdentity.platform === "discord"
                    ? "Discord ID"
                    : "Phone"}{" "}
                {platformIdentity.platformUserId}
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
              Connect this {messagingPlatformLabel(platformIdentity.platform)}{" "}
              account
            </Button>
          </div>
        ) : renderedPhase === "done" ? (
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
            {platformIdentity?.returnUrl ? (
              <Button
                asChild
                className="bg-txt px-6 py-2.5 font-semibold text-bg transition-colors hover:bg-txt/90"
              >
                <a href={platformIdentity.returnUrl}>
                  Back to {messagingPlatformLabel(platformIdentity.platform)}
                </a>
              </Button>
            ) : null}
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
        ) : renderedPhase === "error" ? (
          <div className="flex flex-col items-center gap-4">
            <h1 className="font-poppins text-lg font-semibold text-white">
              {t("cloud.getStarted.errorTitle", {
                defaultValue: "Couldn't connect your account",
              })}
            </h1>
            <p className="text-sm text-white/70">{renderedError}</p>
            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                if (telegramClaimPersistenceBlocked) {
                  window.location.reload();
                  return;
                }
                if (telegramClaimToken) {
                  void claimTelegramAccount(telegramClaimToken);
                  return;
                }
                const token = peekPendingOnboardingSession();
                if (!token) return;
                if (platformIdentity) void redeem(token);
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
                  renderedPhase === "checking"
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
