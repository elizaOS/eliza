/**
 * Steward email magic-link callback (public). Verifies the token/email via the
 * Steward auth context, syncs the session cookie, then redirects to the stored
 * app-authorize returnTo (third-party app integration) or the default login
 * destination `/join` (ordinary Eliza Cloud login).
 */

import {
  getStewardTabSessionAuthorityCoordinator,
  STEWARD_SESSION_AUTHORITY_TIMEOUT_MS,
  StewardSessionAuthorityError,
} from "@elizaos/shared/steward-session-client";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  APP_AUTHORIZE_PATH,
  clearStoredAppAuthorizeReturnTo,
  readStoredAppAuthorizeReturnTo,
} from "../../../../cloud-ui/components/auth/authorize-return";
import { Button } from "../../../../components/primitives";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import {
  LocalStewardAuthContext,
  StewardAuthProvider,
} from "../../../shell/StewardProvider";
import type { LocalStewardAuthValue } from "../../../shell/StewardProviderShared";
import {
  configuredStewardTenantId,
  DEFAULT_STEWARD_TENANT_ID,
} from "../../../shell/steward-config";
import { resolveBrowserStewardApiUrl } from "../../../shell/steward-url";
import {
  capturePendingOAuthReturnTo,
  defaultLoginReturnTo,
} from "../../lib/login-return-to";
import { startStewardEmailLogin } from "../../lib/steward-email-login";
import { publishStewardEmailLoginComplete } from "../../lib/steward-email-login-complete";
import { syncStewardSessionCookie } from "../../lib/steward-session";
import { usePageTitle } from "../../lib/use-page-title";

type CallbackStatus = "verifying" | "success" | "error";
type ResendStatus = "idle" | "sending" | "sent" | "error";

const EMAIL_RESEND_COOLDOWN_MS = 30_000;
const STEWARD_TENANT_ID = configuredStewardTenantId(DEFAULT_STEWARD_TENANT_ID);

type PendingEmailVerification = {
  controller: AbortController;
  subscribers: Set<symbol>;
  promise: Promise<string>;
};

export function resolveEmailCallbackDestination(
  appAuthorizeReturnTo: string | null,
  pendingLoginReturnTo: string | null,
): string {
  return appAuthorizeReturnTo ?? pendingLoginReturnTo ?? defaultLoginReturnTo();
}

/**
 * Classifies a resolved email-callback destination so the success copy and
 * manual fallback button describe the actual context instead of always
 * claiming an app-authorization return.
 *
 * - explicit third-party app authorization targets are identified by the
 *   app-authorization path prefix;
 * - the ordinary login fallback (`/join`) is the default destination;
 * - anything else is a validated same-origin return target that gets
 *   neutral destination-safe wording.
 */
export function classifyEmailCallbackDestination(destination: string): {
  isAppAuthorization: boolean;
  isJoinFallback: boolean;
} {
  const isAppAuthorization =
    destination === APP_AUTHORIZE_PATH ||
    destination.startsWith(`${APP_AUTHORIZE_PATH}?`) ||
    destination.startsWith(`${APP_AUTHORIZE_PATH}#`);
  const isJoinFallback = destination === defaultLoginReturnTo();
  return { isAppAuthorization, isJoinFallback };
}

const pendingEmailVerifications = new Map<string, PendingEmailVerification>();

function verifyEmailCallbackSingleFlight(
  verify: LocalStewardAuthValue["verifyEmailCallback"],
  token: string,
  email: string,
  returnTo: string | null,
): PendingEmailVerification {
  const key = `${email}\0${token}`;
  const pending = pendingEmailVerifications.get(key);
  if (pending) return pending;

  // The whole callback transaction belongs to one flight, including cookie
  // synchronization and receipt publication. A provider remount cannot consume
  // the same one-time link again while that transaction is still completing.
  const authoritySnapshot =
    getStewardTabSessionAuthorityCoordinator().readSnapshot();
  const pendingReturnTo = capturePendingOAuthReturnTo();
  const controller = new AbortController();
  const deadline = setTimeout(
    () =>
      controller.abort(
        new StewardSessionAuthorityError(
          "Email sign-in took too long.",
          "STEWARD_SESSION_AUTHORITY_TIMEOUT",
        ),
      ),
    STEWARD_SESSION_AUTHORITY_TIMEOUT_MS,
  );
  const promise = Promise.resolve()
    .then(async () => {
      controller.signal.throwIfAborted();
      const result = await verify(
        token,
        email,
        authoritySnapshot,
        controller.signal,
        (candidate, authority) =>
          syncStewardSessionCookie(candidate.token, candidate.refreshToken, {
            authority,
          }),
      );
      controller.signal.throwIfAborted();
      return getStewardTabSessionAuthorityCoordinator().runExclusive({
        kind: "callback-restore",
        expectedToken: result.token,
        expectedGeneration: authoritySnapshot.generation,
        expectedScope: authoritySnapshot.scope,
        signal: controller.signal,
        work: async (authority) => {
          authority.revalidate();
          const destination = resolveEmailCallbackDestination(
            returnTo,
            pendingReturnTo.returnTo,
          );
          pendingReturnTo.consume();
          if (readStoredAppAuthorizeReturnTo() === returnTo)
            clearStoredAppAuthorizeReturnTo();
          publishStewardEmailLoginComplete(email, destination);
          return destination;
        },
      });
    })
    .finally(() => {
      clearTimeout(deadline);
      if (pendingEmailVerifications.get(key) === flight) {
        pendingEmailVerifications.delete(key);
      }
    });
  const flight = { controller, subscribers: new Set<symbol>(), promise };
  pendingEmailVerifications.set(key, flight);
  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(deadline);
      if (pendingEmailVerifications.get(key) === flight)
        pendingEmailVerifications.delete(key);
    },
    { once: true },
  );
  return flight;
}

function describeVerificationError(
  error: unknown,
  t: ReturnType<typeof useCloudT>,
): string {
  if (error instanceof StewardSessionAuthorityError) {
    if (error.code === "STEWARD_SESSION_AUTHORITY_CANCELLED") {
      return t("cloud.emailCallback.cancelled", {
        defaultValue: "Sign-in was cancelled. Please start sign-in again.",
      });
    }
    if (error.code === "STEWARD_SESSION_AUTHORITY_SUPERSEDED") {
      return t("cloud.emailCallback.sessionChanged", {
        defaultValue:
          "Your session changed while this link was being checked. Please start sign-in again.",
      });
    }
    if (error.code === "STEWARD_SESSION_AUTHORITY_TIMEOUT") {
      return t("cloud.emailCallback.timedOut", {
        defaultValue: "Sign-in took too long. Please start sign-in again.",
      });
    }
    return t("cloud.emailCallback.sessionUnavailable", {
      defaultValue:
        "Sign-in could not be completed safely. Please return to sign-in and try again.",
    });
  }
  const status =
    error !== null && typeof error === "object" && "status" in error
      ? Reflect.get(error, "status")
      : undefined;
  if (status === 401 || status === 403 || status === 410) {
    return t("cloud.login.callback.codeRejected", {
      defaultValue:
        "That sign-in link expired or was already used. Please sign in again.",
    });
  }
  return error instanceof Error
    ? error.message
    : t("cloud.emailCallback.verifyFailed", {
        defaultValue: "Could not verify this sign-in link.",
      });
}

/**
 * Remove the one-time proof and its identity hint from the visible URL without
 * notifying React Router. The callback already captured both values for this
 * render; retaining unrelated query state and the hash keeps observability and
 * same-page anchors intact while secrets leave history and copy/paste early.
 */
function stripEmailCallbackSecretsFromAddressBar(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("token") && !url.searchParams.has("email")) return;
  url.searchParams.delete("token");
  url.searchParams.delete("email");
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

// `public: true` routes render WITHOUT the per-route Steward wrapper (see
// `CloudRouteElement` / `app-authorize-page` #9881), so this page must mount the
// shell's `StewardAuthProvider` itself. Otherwise the magic-link verify has no
// Steward context, `auth` is null, and a first-time signed-out visitor (no
// stored token, cold browser) just gets "Sign-in is unavailable". `/auth` is
// already in `StewardAuthProvider`'s runtime route patterns, so the Steward
// runtime mounts even for that visitor.
export default function EmailCallbackPage() {
  return (
    <StewardAuthProvider>
      <EmailCallbackContent />
    </StewardAuthProvider>
  );
}

function EmailCallbackContent() {
  const t = useCloudT();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const auth = useContext(LocalStewardAuthContext);
  const callbackRef = useRef<{
    key: string;
    flight: PendingEmailVerification;
  } | null>(null);
  const translatorRef = useRef(t);
  translatorRef.current = t;
  const successDestinationRef = useRef<string | null>(null);
  const [status, setStatus] = useState<CallbackStatus>("verifying");
  const [error, setError] = useState<string | null>(null);
  const [resendStatus, setResendStatus] = useState<ResendStatus>("idle");
  const [resendError, setResendError] = useState<string | null>(null);
  const [resendAvailableAt, setResendAvailableAt] = useState(0);
  const [resendRemainingSeconds, setResendRemainingSeconds] = useState(0);

  usePageTitle(
    t("cloud.emailCallback.metaTitle", {
      defaultValue: "Email Sign-In | Eliza Cloud",
    }),
  );

  const returnTo = useMemo(readStoredAppAuthorizeReturnTo, []);
  const email = searchParams.get("email")?.trim() ?? "";

  useEffect(() => {
    if (resendAvailableAt === 0) return;
    const update = () => {
      setResendRemainingSeconds(
        Math.ceil(Math.max(0, resendAvailableAt - Date.now()) / 1000),
      );
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [resendAvailableAt]);

  useEffect(() => {
    const token = searchParams.get("token");
    const callbackEmail = searchParams.get("email");
    stripEmailCallbackSecretsFromAddressBar();

    if (!auth) {
      setStatus("error");
      setError(
        t("cloud.emailCallback.unavailable", {
          defaultValue:
            "Sign-in is unavailable. Start sign-in again from the app.",
        }),
      );
      return;
    }

    if (!token || !callbackEmail) {
      setStatus("error");
      setError(
        t("cloud.emailCallback.missingToken", {
          defaultValue: "This sign-in link is missing its token or email.",
        }),
      );
      return;
    }

    const key = `${callbackEmail}\0${token}`;
    if (callbackRef.current?.key !== key) {
      try {
        callbackRef.current = {
          key,
          flight: verifyEmailCallbackSingleFlight(
            auth.verifyEmailCallback,
            token,
            callbackEmail,
            returnTo,
          ),
        };
        setStatus("verifying");
        setError(null);
      } catch (error) {
        // error-policy:J4 unreadable original authority remains visible recovery,
        // not an effect exception or an implicitly renewed callback attempt.
        setStatus("error");
        setError(describeVerificationError(error, translatorRef.current));
        return;
      }
    }
    const flight = callbackRef.current.flight;
    const subscriber = Symbol("email-callback");
    flight.subscribers.add(subscriber);
    const ownsResult = () =>
      flight.subscribers.has(subscriber) && !flight.controller.signal.aborted;
    const showCancellation = () => {
      if (!flight.subscribers.has(subscriber)) return;
      setStatus("error");
      setError(
        describeVerificationError(
          flight.controller.signal.reason,
          translatorRef.current,
        ),
      );
    };
    const abandon = () =>
      flight.controller.abort(
        new StewardSessionAuthorityError(
          "Sign-in was cancelled. Please start sign-in again.",
          "STEWARD_SESSION_AUTHORITY_CANCELLED",
        ),
      );
    flight.controller.signal.addEventListener("abort", showCancellation);
    window.addEventListener("pagehide", abandon);
    if (flight.controller.signal.aborted) showCancellation();
    void flight.promise.then(
      (destination) => {
        if (!ownsResult()) return;
        successDestinationRef.current = destination;
        setStatus("success");
      },
      (err: unknown) => {
        // error-policy:J4 only the active callback subscriber can publish recovery.
        if (ownsResult()) {
          setStatus("error");
          setError(describeVerificationError(err, translatorRef.current));
        }
      },
    );
    return () => {
      window.removeEventListener("pagehide", abandon);
      flight.controller.signal.removeEventListener("abort", showCancellation);
      flight.subscribers.delete(subscriber);
      // Immediate StrictMode/provider resubscription keeps the one-time flight;
      // real route departure cancels its remaining network and commit work.
      queueMicrotask(() => {
        if (flight.subscribers.size === 0) abandon();
      });
    };
  }, [auth, returnTo, searchParams, t]);

  async function handleResend() {
    if (!email || resendStatus === "sending" || resendRemainingSeconds > 0) {
      return;
    }
    setResendStatus("sending");
    setResendError(null);
    try {
      await startStewardEmailLogin(
        {
          baseUrl: resolveBrowserStewardApiUrl(),
          tenantId: STEWARD_TENANT_ID,
        },
        email,
      );
      setResendAvailableAt(Date.now() + EMAIL_RESEND_COOLDOWN_MS);
      setResendStatus("sent");
    } catch (resendFailure) {
      // error-policy:J4 a failed resend remains on the explicit recovery
      // surface and reports the failure without fabricating a fresh challenge.
      setResendStatus("error");
      setResendError(
        resendFailure instanceof Error
          ? resendFailure.message
          : "Could not resend the sign-in email. Try again.",
      );
    }
  }

  useEffect(() => {
    if (status !== "success") return;
    const destination = successDestinationRef.current ?? defaultLoginReturnTo();
    const redirectTimer = setTimeout(() => {
      navigate(destination, { replace: true });
    }, 1500);
    return () => clearTimeout(redirectTimer);
  }, [navigate, status]);

  if (status === "error") {
    return (
      <Frame>
        <div className="bg-accent p-4 text-accent-foreground">
          <AlertTriangle className="size-8" />
        </div>
        <h1 className="text-lg font-semibold text-txt">
          {t("cloud.emailCallback.signInFailed", {
            defaultValue: "Sign-in failed",
          })}
        </h1>
        <p className="max-w-xs text-center text-sm text-muted" role="alert">
          {error}
        </p>
        {resendStatus === "sent" && (
          <p className="text-center text-sm text-muted" role="status">
            {t("cloud.emailCallback.resent", {
              defaultValue: "A new sign-in email is on its way.",
            })}
          </p>
        )}
        {resendError && (
          <p className="text-center text-sm text-destructive" role="alert">
            {resendError}
          </p>
        )}
        {email ? (
          <Button
            className="hosted-signin-focus-emphasis mt-2"
            type="button"
            onClick={handleResend}
            disabled={resendStatus === "sending" || resendRemainingSeconds > 0}
          >
            {resendStatus === "sending"
              ? t("cloud.emailCallback.resending", {
                  defaultValue: "Resending...",
                })
              : resendRemainingSeconds > 0
                ? `Resend in ${resendRemainingSeconds}s`
                : t("cloud.emailCallback.resend", {
                    defaultValue: "Resend sign-in email",
                  })}
          </Button>
        ) : null}
        <Button
          asChild
          className="hosted-signin-focus-emphasis mt-2"
          variant={email ? "ghostMuted" : "default"}
        >
          <a href="/login">
            {email
              ? t("cloud.login.backToLogin", {
                  defaultValue: "Back to login",
                })
              : t("cloud.cliLogin.signInAgain", {
                  defaultValue: "Sign In Again",
                })}
          </a>
        </Button>
      </Frame>
    );
  }

  if (status === "success") {
    const destination = successDestinationRef.current ?? defaultLoginReturnTo();
    const { isAppAuthorization, isJoinFallback } =
      classifyEmailCallbackDestination(destination);
    const successCopy = isAppAuthorization
      ? t("cloud.emailCallback.returning", {
          defaultValue: "Returning to the app authorization screen...",
        })
      : t("cloud.emailCallback.openingEliza", {
          defaultValue: "Opening Eliza...",
        });
    const buttonCopy = isAppAuthorization
      ? t("cloud.emailCallback.continue", {
          defaultValue: "Continue to app authorization",
        })
      : isJoinFallback
        ? t("cloud.emailCallback.continueToEliza", {
            defaultValue: "Continue to Eliza",
          })
        : t("cloud.emailCallback.continue", {
            defaultValue: "Continue",
          });
    return (
      <Frame>
        <CheckCircle2 className="size-12 text-txt" />
        <h1 className="text-lg font-semibold text-txt">
          {t("cloud.emailCallback.signedIn", { defaultValue: "Signed in" })}
        </h1>
        <p className="text-sm text-muted">{successCopy}</p>
        <Button
          className="mt-2"
          onClick={() => navigate(destination, { replace: true })}
        >
          {buttonCopy}
        </Button>
      </Frame>
    );
  }

  return (
    <Frame>
      <Loader2 className="size-12 animate-spin text-accent" />
      <h1 className="text-lg font-semibold text-txt">
        {t("cloud.emailCallback.verifying", {
          defaultValue: "Verifying sign-in link...",
        })}
      </h1>
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <main className="theme-cloud relative flex min-h-[100dvh] w-full flex-col overflow-hidden bg-bg font-sans text-txt">
      <div className="relative z-10 flex flex-1 items-center justify-center p-4">
        <div className="w-full max-w-md border border-border bg-card p-8">
          <div className="flex flex-col items-center gap-6">{children}</div>
        </div>
      </div>
    </main>
  );
}
