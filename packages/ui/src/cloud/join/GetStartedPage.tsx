/**
 * `/get-started` continues a trusted messaging session into Eliza Cloud.
 *
 * The browser credential is verified in storage before it leaves the URL.
 * Storage uncertainty is a visible blocking state: it cannot fall through to
 * login, ordinary Cloud setup, identity confirmation, or a repeated redeem.
 * The existing read-only preview, explicit confirmation, single redemption,
 * and validated messaging return flow remain the transport authority.
 */

import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared/brand";
import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/button";
import { useCloudT } from "../shell/CloudI18nProvider";
import {
  acknowledgeOnboardingContinuationCompletion,
  clearPendingOnboardingSession,
  clearPendingOnboardingSessionIfToken,
  completePendingOnboardingContinuation,
  type MessagingContinuationPreview,
  observePendingOnboardingContinuationCompletion,
  observeRecentOnboardingContinuationCompletion,
  type PendingOnboardingSessionState,
  peekPendingOnboardingSession,
  previewPendingOnboardingContinuation,
  sanitizeOnboardingSessionToken,
  storePendingOnboardingSession,
} from "./lib/onboarding-continuation";
import { useJoinSessionAuth } from "./lib/use-join-session";

type StorageOperation = "persist" | "peek" | "clear";

type CredentialState =
  | { kind: "resolving" }
  | { kind: "absent" }
  | {
      kind: "present";
      token: string;
      redemption: Extract<
        PendingOnboardingSessionState,
        { presence: "present" }
      >["redemption"];
    }
  | {
      kind: "storage-error";
      operation: StorageOperation;
      token: string | null;
    };

type LinkState =
  | { phase: "idle" }
  | { phase: "checking"; token: string }
  | {
      phase: "confirm";
      token: string;
      identity: MessagingContinuationPreview;
    }
  | {
      phase: "linking";
      token: string;
      identity: MessagingContinuationPreview;
    }
  | {
      phase: "done";
      token: string;
      identity: MessagingContinuationPreview | null;
    }
  | {
      phase: "error";
      token: string;
      operation: "preview" | "redeem";
      message: string;
      identity: MessagingContinuationPreview | null;
    }
  | {
      phase: "cleanup-error";
      token: string;
      identity: MessagingContinuationPreview | null;
    };

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

function credentialFromPresence(
  pending: PendingOnboardingSessionState,
  operation: StorageOperation,
  token: string | null = null,
): CredentialState {
  if (pending.presence === "present") {
    return {
      kind: "present",
      token: pending.token,
      redemption: pending.redemption,
    };
  }
  if (pending.presence === "absent") return { kind: "absent" };
  return { kind: "storage-error", operation, token };
}

function isExpectedPendingToken(
  pending: PendingOnboardingSessionState,
  token: string,
): boolean {
  return (
    pending.presence === "present" &&
    pending.token === token &&
    pending.redemption === "pending"
  );
}

export default function GetStartedPage(): React.JSX.Element {
  const t = useCloudT();
  const session = useJoinSessionAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [credential, setCredential] = useState<CredentialState>({
    kind: "resolving",
  });
  const [resolvedSearch, setResolvedSearch] = useState<string | null>(null);
  const [link, setLink] = useState<LinkState>({ phase: "idle" });
  const previewedTokenRef = useRef<string | null>(null);
  const redeemingTokensRef = useRef(new Set<string>());
  const latestRedemptionTokenRef = useRef<string | null>(null);
  const completionHeadingRef = useRef<HTMLHeadingElement>(null);
  const linkingStatusRef = useRef<HTMLDivElement>(null);
  const recoveryActionRef = useRef<HTMLButtonElement>(null);
  const ingestedUrlRef = useRef<{
    search: string;
    token: string;
    pending: PendingOnboardingSessionState;
  } | null>(null);
  const observedCompletionRef = useRef<string | null>(null);

  const removeOnboardingSessionFromUrl = useCallback(() => {
    const nextParams = new URLSearchParams(location.search);
    nextParams.delete("onboardingSession");
    const nextSearch = nextParams.toString();
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

  const inspectStoredCredential = useCallback(() => {
    const pending = peekPendingOnboardingSession();
    const recent =
      pending.presence === "absent"
        ? observeRecentOnboardingContinuationCompletion()
        : null;
    setCredential(credentialFromPresence(pending, "peek"));
    if (recent) {
      setLink({ phase: "done", token: recent.token, identity: null });
    }
    setResolvedSearch(location.search);
  }, [location.search]);

  // Router-owned reconciliation keeps the credential in the URL until at
  // least one browser store verifies the exact record. `resolvedSearch` keeps
  // the render blocked while the router and storage state converge.
  useEffect(() => {
    const token = sanitizeOnboardingSessionToken(
      new URLSearchParams(location.search).get("onboardingSession"),
    );
    if (!token) {
      ingestedUrlRef.current = null;
      inspectStoredCredential();
      return;
    }

    const stored =
      ingestedUrlRef.current?.search === location.search &&
      ingestedUrlRef.current.token === token
        ? ingestedUrlRef.current.pending
        : storePendingOnboardingSession(token);
    ingestedUrlRef.current = {
      search: location.search,
      token,
      pending: stored,
    };
    setCredential(credentialFromPresence(stored, "persist", token));
    setResolvedSearch(location.search);
    if (stored.presence === "present" && stored.token === token) {
      removeOnboardingSessionFromUrl();
    }
  }, [
    inspectStoredCredential,
    location.search,
    removeOnboardingSessionFromUrl,
  ]);

  const blockForUnexpectedPresence = useCallback(
    (pending: PendingOnboardingSessionState, token: string) => {
      previewedTokenRef.current = null;
      setLink({ phase: "idle" });
      setCredential(
        pending.presence === "present"
          ? credentialFromPresence(pending, "peek")
          : {
              kind: "storage-error",
              operation: "peek",
              token,
            },
      );
    },
    [],
  );

  const preview = useCallback(
    async (token: string) => {
      const pending = peekPendingOnboardingSession();
      if (!isExpectedPendingToken(pending, token)) {
        blockForUnexpectedPresence(pending, token);
        return;
      }
      previewedTokenRef.current = token;
      setLink({ phase: "checking", token });
      try {
        const identity = await previewPendingOnboardingContinuation(token);
        if (
          previewedTokenRef.current !== token ||
          !isExpectedPendingToken(peekPendingOnboardingSession(), token)
        ) {
          return;
        }
        setLink({ phase: "confirm", token, identity });
      } catch (err) {
        if (
          previewedTokenRef.current !== token ||
          !isExpectedPendingToken(peekPendingOnboardingSession(), token)
        ) {
          return;
        }
        // error-policy:J4 transport failure remains a visible retryable state;
        // it never fabricates an identity or crosses the redemption boundary.
        setLink({
          phase: "error",
          token,
          operation: "preview",
          message: describeContinuationError(err),
          identity: null,
        });
      }
    },
    [blockForUnexpectedPresence],
  );

  useEffect(() => {
    if (!session.ready || !session.authenticated) return;
    if (credential.kind !== "present") return;
    if (credential.redemption !== "pending") return;
    if (previewedTokenRef.current === credential.token) return;
    if (observePendingOnboardingContinuationCompletion(credential.token)) {
      return;
    }
    void preview(credential.token);
  }, [credential, preview, session.authenticated, session.ready]);

  const reconcileRedemption = useCallback(
    (
      pending: PendingOnboardingSessionState,
      token: string,
      identity: MessagingContinuationPreview | null,
    ) => {
      if (pending.presence === "absent") {
        setLink({ phase: "done", token, identity });
      } else if (pending.presence === "present" && pending.token !== token) {
        setCredential(credentialFromPresence(pending, "peek"));
        if (previewedTokenRef.current !== pending.token) {
          previewedTokenRef.current = null;
          setLink({ phase: "idle" });
        }
      } else {
        setLink({ phase: "cleanup-error", token, identity });
      }
    },
    [],
  );

  useEffect(() => {
    if (credential.kind !== "present") return;
    const token = credential.token;
    if (observedCompletionRef.current === token) return;
    const completion = observePendingOnboardingContinuationCompletion(token);
    if (!completion) return;
    observedCompletionRef.current = token;
    void completion
      .then((pending) => {
        reconcileRedemption(pending, token, null);
      })
      .catch((err) => {
        // error-policy:J4 a failed observed flight remains pending and is
        // retried only through the existing explicit confirmation boundary.
        if (observedCompletionRef.current === token) {
          observedCompletionRef.current = null;
        }
        const pending = peekPendingOnboardingSession();
        if (isExpectedPendingToken(pending, token)) {
          setLink({
            phase: "error",
            token,
            operation: "preview",
            message: describeContinuationError(err),
            identity: null,
          });
        } else {
          blockForUnexpectedPresence(pending, token);
        }
      });
  }, [blockForUnexpectedPresence, credential, reconcileRedemption]);

  const redeem = useCallback(
    async (token: string, identity: MessagingContinuationPreview) => {
      if (redeemingTokensRef.current.has(token)) return;
      const pending = peekPendingOnboardingSession();
      if (!isExpectedPendingToken(pending, token)) {
        blockForUnexpectedPresence(pending, token);
        return;
      }
      redeemingTokensRef.current.add(token);
      latestRedemptionTokenRef.current = token;
      setLink({ phase: "linking", token, identity });
      try {
        const cleared = await completePendingOnboardingContinuation(token);
        if (
          latestRedemptionTokenRef.current !== token ||
          previewedTokenRef.current !== token
        ) {
          return;
        }
        reconcileRedemption(cleared, token, identity);
      } catch (err) {
        if (
          previewedTokenRef.current !== token ||
          !isExpectedPendingToken(peekPendingOnboardingSession(), token)
        ) {
          return;
        }
        // error-policy:J4 a failed explicit redemption remains visibly
        // retryable and does not masquerade as a completed connection.
        setLink({
          phase: "error",
          token,
          operation: "redeem",
          message: describeContinuationError(err),
          identity,
        });
      } finally {
        redeemingTokensRef.current.delete(token);
      }
    },
    [blockForUnexpectedPresence, reconcileRedemption],
  );

  const dismissCredential = useCallback(() => {
    const cleared = clearPendingOnboardingSession();
    if (cleared.presence !== "absent") {
      setCredential({
        kind: "storage-error",
        operation: "clear",
        token: credential.kind === "storage-error" ? credential.token : null,
      });
      return;
    }
    removeOnboardingSessionFromUrl();
    setCredential({ kind: "absent" });
  }, [credential, removeOnboardingSessionFromUrl]);

  const retryCredential = useCallback(() => {
    if (credential.kind !== "storage-error") return;
    if (credential.operation === "persist" && credential.token) {
      const stored = storePendingOnboardingSession(credential.token);
      setCredential(
        credentialFromPresence(stored, "persist", credential.token),
      );
      if (stored.presence === "present" && stored.token === credential.token) {
        removeOnboardingSessionFromUrl();
      }
      return;
    }
    if (credential.operation === "peek") {
      if (!credential.token) {
        inspectStoredCredential();
        return;
      }
      const pending = peekPendingOnboardingSession();
      setCredential(
        pending.presence === "present"
          ? credentialFromPresence(pending, "peek")
          : {
              kind: "storage-error",
              operation: "peek",
              token: credential.token,
            },
      );
      return;
    }
    dismissCredential();
  }, [
    credential,
    dismissCredential,
    inspectStoredCredential,
    removeOnboardingSessionFromUrl,
  ]);

  const retryRedeemedCleanup = useCallback(
    (token: string, identity: MessagingContinuationPreview | null) => {
      reconcileRedemption(
        clearPendingOnboardingSessionIfToken(token),
        token,
        identity,
      );
    },
    [reconcileRedemption],
  );

  useEffect(() => {
    if (link.phase === "done") {
      completionHeadingRef.current?.focus();
      acknowledgeOnboardingContinuationCompletion(link.token);
    } else if (link.phase === "linking") {
      linkingStatusRef.current?.focus();
    } else if (link.phase === "error" || link.phase === "cleanup-error") {
      recoveryActionRef.current?.focus();
    }
  }, [link]);

  if (
    resolvedSearch !== location.search ||
    credential.kind === "resolving" ||
    !session.ready
  ) {
    return (
      <PageFrame>
        <LoadingState t={t} checking />
      </PageFrame>
    );
  }

  if (credential.kind === "storage-error") {
    return (
      <PageFrame>
        <StorageError
          t={t}
          mode={credential.operation === "clear" ? "clear" : "recoverable"}
          onRetry={retryCredential}
          onDismiss={
            credential.operation === "clear" ? undefined : dismissCredential
          }
        />
      </PageFrame>
    );
  }

  if (link.phase === "done") {
    return (
      <PageFrame>
        <div className="flex flex-col items-center gap-4">
          <h1
            ref={completionHeadingRef}
            tabIndex={-1}
            className="font-poppins text-lg font-semibold text-white"
          >
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
          {link.identity?.returnUrl ? (
            <Button
              asChild
              className="bg-txt px-6 py-2.5 font-semibold text-bg transition-colors hover:bg-txt/90"
            >
              <a href={link.identity.returnUrl}>
                Back to {messagingPlatformLabel(link.identity.platform)}
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
      </PageFrame>
    );
  }

  if (link.phase === "cleanup-error") {
    return (
      <PageFrame>
        <StorageError
          t={t}
          mode="post-redeem"
          onRetry={() => retryRedeemedCleanup(link.token, link.identity)}
          retryButtonRef={recoveryActionRef}
        />
      </PageFrame>
    );
  }

  if (credential.kind === "present" && credential.redemption === "committed") {
    return (
      <PageFrame>
        <StorageError
          t={t}
          mode="post-redeem"
          onRetry={() => retryRedeemedCleanup(credential.token, null)}
        />
      </PageFrame>
    );
  }

  if (!session.authenticated) {
    return <Navigate to="/login?returnTo=/get-started" replace />;
  }

  if (credential.kind === "absent") {
    return <Navigate to="/join" replace />;
  }

  const token = credential.token;
  const identity =
    (link.phase === "confirm" || link.phase === "linking") &&
    link.token === token
      ? link.identity
      : link.phase === "error" && link.token === token
        ? link.identity
        : null;

  return (
    <PageFrame>
      {link.phase === "confirm" && link.token === token ? (
        <div className="flex flex-col items-center gap-4">
          <h1 className="font-poppins text-lg font-semibold text-white">
            Connect your {messagingPlatformLabel(link.identity.platform)}{" "}
            account?
          </h1>
          <p className="text-sm text-white/70">
            Continue with <strong>{link.identity.platformDisplayName}</strong>
            <span className="block break-all text-xs text-white/50">
              {link.identity.platform === "telegram"
                ? "Telegram ID"
                : link.identity.platform === "discord"
                  ? "Discord ID"
                  : "Phone"}{" "}
              {link.identity.platformUserId}
            </span>
          </p>
          <Button
            type="button"
            onClick={() => void redeem(link.token, link.identity)}
            className="bg-txt px-6 py-2.5 font-semibold text-bg"
          >
            Connect this {messagingPlatformLabel(link.identity.platform)}{" "}
            account
          </Button>
        </div>
      ) : link.phase === "error" && link.token === token ? (
        <div className="flex flex-col items-center gap-4" role="alert">
          <h1 className="font-poppins text-lg font-semibold text-white">
            {t("cloud.getStarted.errorTitle", {
              defaultValue: "Couldn't connect your account",
            })}
          </h1>
          <p className="text-sm text-white/70">{link.message}</p>
          <Button
            ref={recoveryActionRef}
            variant="ghost"
            type="button"
            onClick={() => {
              if (link.operation === "redeem" && identity) {
                void redeem(link.token, identity);
              } else {
                void preview(link.token);
              }
            }}
            className="bg-txt px-6 py-2.5 font-semibold text-bg transition-colors hover:bg-txt/90"
          >
            {t("cloud.getStarted.retry", { defaultValue: "Try again" })}
          </Button>
        </div>
      ) : (
        <LoadingState
          t={t}
          checking={link.phase === "checking" && link.token === token}
          statusRef={link.phase === "linking" ? linkingStatusRef : undefined}
        />
      )}
    </PageFrame>
  );
}

interface PageFrameProps {
  children: React.ReactNode;
}

function PageFrame({ children }: PageFrameProps): React.JSX.Element {
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
        {children}
      </div>
    </div>
  );
}

interface LoadingStateProps {
  t: ReturnType<typeof useCloudT>;
  checking: boolean;
  statusRef?: React.Ref<HTMLDivElement>;
}

function LoadingState({
  t,
  checking,
  statusRef,
}: LoadingStateProps): React.JSX.Element {
  return (
    <div
      ref={statusRef}
      tabIndex={statusRef ? -1 : undefined}
      className="flex flex-col items-center gap-4"
      role="status"
      aria-busy="true"
    >
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/80 border-t-transparent" />
      <p className="text-sm text-white/72">
        {t("cloud.getStarted.linking", {
          defaultValue: checking
            ? "Checking your connection..."
            : "Connecting your account...",
        })}
      </p>
    </div>
  );
}

interface StorageErrorProps {
  t: ReturnType<typeof useCloudT>;
  mode: "recoverable" | "clear" | "post-redeem";
  onRetry: () => void;
  onDismiss?: () => void;
  retryButtonRef?: React.Ref<HTMLButtonElement>;
}

function StorageError({
  t,
  mode,
  onRetry,
  onDismiss,
  retryButtonRef,
}: StorageErrorProps): React.JSX.Element {
  const title =
    mode === "post-redeem"
      ? t("cloud.getStarted.storageCleanupErrorTitle", {
          defaultValue: "You're connected, but cleanup needs attention",
        })
      : t("cloud.getStarted.storageErrorTitle", {
          defaultValue: "Your browser could not verify this connection",
        });
  const body =
    mode === "post-redeem"
      ? t("cloud.getStarted.storageCleanupErrorBody", {
          defaultValue:
            "Your account is connected. Try again to remove the saved browser connection; this will not reconnect the account.",
        })
      : mode === "clear"
        ? t("cloud.getStarted.storageClearErrorBody", {
            defaultValue:
              "Try again. Setup stays blocked until your browser confirms the saved connection was removed.",
          })
        : t("cloud.getStarted.storageErrorBody", {
            defaultValue:
              "Try again, or dismiss this connection. Setup continues only after your browser verifies the saved connection state.",
          });
  return (
    <div className="flex flex-col items-center gap-4" role="alert">
      <h1 className="font-poppins text-lg font-semibold text-white">{title}</h1>
      <p className="text-sm leading-6 text-white/70">{body}</p>
      <div className="flex flex-wrap justify-center gap-3">
        <Button
          ref={retryButtonRef}
          type="button"
          variant="ghost"
          onClick={onRetry}
          className="bg-txt px-6 py-2.5 font-semibold text-bg transition-colors hover:bg-txt/90"
        >
          {t("cloud.getStarted.retry", { defaultValue: "Try again" })}
        </Button>
        {onDismiss ? (
          <Button type="button" variant="outline" onClick={onDismiss}>
            {t("common.dismiss", { defaultValue: "Dismiss" })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
