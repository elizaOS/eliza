/**
 * `/get-started` is the explicit Cloud setup boundary and the fail-closed
 * landing for messaging-to-Cloud continuations.
 *
 * The current continuation API resolves authentication through a path that
 * can create an account, grant legacy credit, and provision compute. Until the
 * server publishes a non-mutating identity-link contract, this page never
 * calls it. A bare visit likewise stays on a truthful consent screen until the
 * user explicitly chooses to enter the existing Cloud setup flow.
 */

import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared/brand";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "../../components/ui/button";
import { useCloudT } from "../shell/CloudI18nProvider";
import {
  clearPendingOnboardingSession,
  peekPendingOnboardingSession,
  sanitizeOnboardingSessionToken,
  storePendingOnboardingSession,
} from "./lib/onboarding-continuation";

type EntryState =
  | { kind: "paused-continuation" }
  | { kind: "invalid-continuation" }
  | { kind: "setup-consent" };

function removeOnboardingSessionFromUrl(): void {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.delete("onboardingSession");
  window.history.replaceState(
    window.history.state,
    "",
    `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
  );
}

interface InitialEntry {
  entry: EntryState;
  rawToken: string | null;
  restoreStoredToken: boolean;
}

function resolveInitialEntry(searchParams: URLSearchParams): InitialEntry {
  if (!searchParams.has("onboardingSession")) {
    return {
      entry: { kind: "setup-consent" },
      rawToken: null,
      restoreStoredToken: true,
    };
  }

  const rawToken = sanitizeOnboardingSessionToken(
    searchParams.get("onboardingSession"),
  );
  return rawToken
    ? {
        entry: { kind: "paused-continuation" },
        rawToken,
        restoreStoredToken: false,
      }
    : {
        entry: { kind: "invalid-continuation" },
        rawToken: null,
        restoreStoredToken: false,
      };
}

export default function GetStartedPage(): React.JSX.Element {
  const t = useCloudT();
  const [searchParams] = useSearchParams();
  const [{ entry: firstEntry, rawToken, restoreStoredToken }] = useState(() =>
    resolveInitialEntry(searchParams),
  );
  const [entry, setEntry] = useState<EntryState>(firstEntry);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    if (rawToken) {
      if (storePendingOnboardingSession(rawToken)) {
        removeOnboardingSessionFromUrl();
      }
      return;
    }
    if (restoreStoredToken && peekPendingOnboardingSession()) {
      setEntry({ kind: "paused-continuation" });
    }
  }, [rawToken, restoreStoredToken]);

  const dismissContinuation = useCallback(() => {
    clearPendingOnboardingSession();
    removeOnboardingSessionFromUrl();
    setEntry({ kind: "setup-consent" });
  }, []);

  useEffect(() => {
    const heading = headingRef.current;
    if (heading?.dataset.entryKind === entry.kind) heading.focus();
  }, [entry.kind]);

  const content =
    entry.kind === "setup-consent" ? (
      <div className="flex flex-col items-center gap-4">
        <h1
          ref={headingRef}
          data-entry-kind={entry.kind}
          tabIndex={-1}
          className="font-poppins text-xl font-semibold text-white outline-none"
        >
          {t("cloud.getStarted.setupTitle", {
            defaultValue: "Set up Eliza Cloud",
          })}
        </h1>
        <p className="text-sm leading-6 text-white/70">
          {t("cloud.getStarted.setupBody", {
            defaultValue:
              "This page does not start an agent. Continue only when you're ready: Cloud setup may select or create an agent, start compute, and use account credit.",
          })}
        </p>
        <Button
          asChild
          className="hosted-signin-focus-emphasis h-auto min-h-11 max-w-full whitespace-normal bg-txt px-6 py-2.5 text-center font-semibold text-bg transition-colors hover:bg-txt/90"
        >
          <Link to="/join">
            {t("cloud.getStarted.setupCta", {
              defaultValue: "Continue to Cloud setup",
            })}
          </Link>
        </Button>
      </div>
    ) : entry.kind === "invalid-continuation" ? (
      <div className="flex flex-col items-center gap-4" role="alert">
        <h1
          ref={headingRef}
          data-entry-kind={entry.kind}
          tabIndex={-1}
          className="font-poppins text-lg font-semibold text-white outline-none"
        >
          {t("cloud.getStarted.continuationInvalidTitle", {
            defaultValue: "This connection link isn't valid",
          })}
        </h1>
        <p className="text-sm leading-6 text-white/70">
          {t("cloud.getStarted.continuationInvalidBody", {
            defaultValue:
              "Return to your messaging app and request a new sign-in link.",
          })}
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={dismissContinuation}
          className="hosted-signin-focus-emphasis h-auto min-h-11 max-w-full whitespace-normal px-6 py-2.5 text-center font-semibold"
        >
          {t("cloud.getStarted.continuationCancel", {
            defaultValue: "Dismiss connection",
          })}
        </Button>
      </div>
    ) : (
      <div className="flex flex-col items-center gap-4" role="status">
        <h1
          ref={headingRef}
          data-entry-kind={entry.kind}
          tabIndex={-1}
          className="font-poppins text-lg font-semibold text-white outline-none"
        >
          {t("cloud.getStarted.continuationPausedTitle", {
            defaultValue: "Messaging connection paused",
          })}
        </h1>
        <p className="text-sm leading-6 text-white/70">
          {t("cloud.getStarted.continuationPausedBody", {
            defaultValue:
              "This page did not verify or link this connection. The current Cloud flow can also add credit and start Dedicated compute, so messaging connections are unavailable until a safe linking flow ships. Keep chatting in your messaging app for now.",
          })}
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={dismissContinuation}
          className="hosted-signin-focus-emphasis h-auto min-h-11 max-w-full whitespace-normal px-6 py-2.5 text-center font-semibold"
        >
          {t("cloud.getStarted.continuationCancel", {
            defaultValue: "Dismiss connection",
          })}
        </Button>
      </div>
    );

  return (
    <div
      className="theme-cloud flex min-h-dvh w-full flex-col items-center justify-center overflow-y-auto bg-black px-4 text-white"
      style={{
        background: "var(--background)",
        paddingTop: "max(1.5rem, env(safe-area-inset-top))",
        paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))",
      }}
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <img
          src={`${BRAND_PATHS.logos}/${LOGO_FILES.cloudWhite}`}
          alt="Eliza Cloud"
          className="h-8 w-auto"
          draggable={false}
        />
        {content}
      </div>
    </div>
  );
}
