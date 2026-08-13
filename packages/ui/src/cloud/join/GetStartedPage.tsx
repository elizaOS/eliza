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
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/button";
import { useCloudT } from "../shell/CloudI18nProvider";
import {
  clearPendingOnboardingSession,
  peekPendingOnboardingSession,
  sanitizeOnboardingSessionToken,
  storePendingOnboardingSession,
} from "./lib/onboarding-continuation";

type EntryState =
  | { kind: "checking-storage" }
  | { kind: "paused-continuation" }
  | { kind: "invalid-continuation" }
  | {
      kind: "storage-error";
      phase: "persist" | "peek" | "clear";
    }
  | { kind: "setup-consent" };

interface InitialEntry {
  entry: EntryState;
  rawToken: string | null;
  restoreStoredToken: boolean;
}

function resolveInitialEntry(searchParams: URLSearchParams): InitialEntry {
  if (!searchParams.has("onboardingSession")) {
    return {
      entry: { kind: "checking-storage" },
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
  const location = useLocation();
  const navigate = useNavigate();
  const [firstEntry] = useState(() =>
    resolveInitialEntry(new URLSearchParams(location.search)),
  );
  const [entry, setEntry] = useState<EntryState>(firstEntry.entry);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const processedRawTokenRef = useRef<string | null>(null);

  const removeOnboardingSessionFromUrl = useCallback(() => {
    const nextSearchParams = new URLSearchParams(location.search);
    nextSearchParams.delete("onboardingSession");
    const nextSearch = nextSearchParams.toString();
    navigate(
      {
        pathname: location.pathname,
        search: nextSearch ? `?${nextSearch}` : "",
        hash: location.hash,
      },
      { replace: true, state: location.state },
    );
  }, [
    location.hash,
    location.pathname,
    location.search,
    location.state,
    navigate,
  ]);

  const peekPendingContinuation = useCallback(() => {
    const pending = peekPendingOnboardingSession();
    if (pending === "present") {
      setEntry({ kind: "paused-continuation" });
    } else if (pending === "indeterminate") {
      setEntry({ kind: "storage-error", phase: "peek" });
    } else {
      setEntry({ kind: "setup-consent" });
    }
  }, []);

  useEffect(() => {
    const currentEntry = resolveInitialEntry(
      new URLSearchParams(location.search),
    );
    if (currentEntry.rawToken) {
      if (processedRawTokenRef.current === currentEntry.rawToken) return;
      processedRawTokenRef.current = currentEntry.rawToken;
      if (storePendingOnboardingSession(currentEntry.rawToken) === "present") {
        setEntry({ kind: "paused-continuation" });
        removeOnboardingSessionFromUrl();
      } else setEntry({ kind: "storage-error", phase: "persist" });
      return;
    }
    processedRawTokenRef.current = null;
    if (currentEntry.restoreStoredToken) peekPendingContinuation();
    else setEntry(currentEntry.entry);
  }, [
    location.search,
    peekPendingContinuation,
    removeOnboardingSessionFromUrl,
  ]);

  const currentUrlEntry = resolveInitialEntry(
    new URLSearchParams(location.search),
  );
  const visibleEntry =
    currentUrlEntry.restoreStoredToken ||
    (currentUrlEntry.rawToken !== null &&
      processedRawTokenRef.current === currentUrlEntry.rawToken)
      ? entry
      : currentUrlEntry.entry;

  const dismissContinuation = useCallback(() => {
    if (clearPendingOnboardingSession() !== "absent") {
      setEntry({ kind: "storage-error", phase: "clear" });
      return;
    }
    removeOnboardingSessionFromUrl();
    setEntry({ kind: "setup-consent" });
  }, [removeOnboardingSessionFromUrl]);

  const retryStorage = useCallback(() => {
    if (entry.kind !== "storage-error") return;
    if (entry.phase === "peek") {
      peekPendingContinuation();
      return;
    }
    if (entry.phase === "persist") {
      const currentToken = resolveInitialEntry(
        new URLSearchParams(location.search),
      ).rawToken;
      if (
        currentToken &&
        storePendingOnboardingSession(currentToken) === "present"
      ) {
        removeOnboardingSessionFromUrl();
        setEntry({ kind: "paused-continuation" });
      }
      return;
    }
    dismissContinuation();
  }, [
    dismissContinuation,
    entry,
    location.search,
    peekPendingContinuation,
    removeOnboardingSessionFromUrl,
  ]);

  useEffect(() => {
    const heading = headingRef.current;
    if (heading?.dataset.entryKind === visibleEntry.kind) heading.focus();
  }, [visibleEntry.kind]);

  const content =
    visibleEntry.kind === "checking-storage" ? (
      <div className="flex flex-col items-center gap-4" role="status">
        <h1
          ref={headingRef}
          data-entry-kind={visibleEntry.kind}
          tabIndex={-1}
          className="font-poppins text-lg font-semibold text-white outline-none"
        >
          {t("common.loading", { defaultValue: "Loading" })}
        </h1>
      </div>
    ) : visibleEntry.kind === "setup-consent" ? (
      <div className="flex flex-col items-center gap-4">
        <h1
          ref={headingRef}
          data-entry-kind={visibleEntry.kind}
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
    ) : visibleEntry.kind === "invalid-continuation" ? (
      <div className="flex flex-col items-center gap-4" role="alert">
        <h1
          ref={headingRef}
          data-entry-kind={visibleEntry.kind}
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
    ) : visibleEntry.kind === "storage-error" ? (
      <div className="flex flex-col items-center gap-4" role="alert">
        <h1
          ref={headingRef}
          data-entry-kind={visibleEntry.kind}
          tabIndex={-1}
          className="font-poppins text-lg font-semibold text-white outline-none"
        >
          {t("cloud.getStarted.continuationStorageErrorTitle", {
            defaultValue: "Browser storage blocked this connection",
          })}
        </h1>
        <p className="text-sm leading-6 text-white/70">
          {t("cloud.getStarted.continuationStorageErrorBody", {
            defaultValue:
              "This page could not safely read, save, or clear the connection. No Cloud request was sent. Check your browser storage settings, then try again.",
          })}
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={retryStorage}
            className="hosted-signin-focus-emphasis h-auto min-h-11 max-w-full whitespace-normal px-6 py-2.5 text-center font-semibold"
          >
            {t("common.retry", {
              defaultValue: "Try again",
            })}
          </Button>
          {visibleEntry.phase !== "clear" ? (
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
          ) : null}
        </div>
      </div>
    ) : (
      <div className="flex flex-col items-center gap-4" role="status">
        <h1
          ref={headingRef}
          data-entry-kind={visibleEntry.kind}
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
