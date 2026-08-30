/**
 * Steward email magic-link callback (public). Verifies the token/email via the
 * Steward auth context, syncs the session cookie, then redirects to the stored
 * app-authorize returnTo (third-party app integration) or the default login
 * destination `/join` (ordinary Eliza Cloud login).
 */

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
import {
  configuredStewardTenantId,
  DEFAULT_STEWARD_TENANT_ID,
} from "../../../shell/steward-config";
import { resolveBrowserStewardApiUrl } from "../../../shell/steward-url";
import {
  consumePendingOAuthReturnTo,
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

type EmailVerificationResult = {
  token: string;
  refreshToken?: string;
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

const pendingEmailVerifications = new Map<
  string,
  Promise<EmailVerificationResult>
>();

function verifyEmailCallbackSingleFlight(
  verify: (token: string, email: string) => Promise<EmailVerificationResult>,
  token: string,
  email: string,
): Promise<EmailVerificationResult> {
  const key = `${email}\0${token}`;
  const pending = pendingEmailVerifications.get(key);
  if (pending) return pending;

  // Deferring the call lets us publish the promise before a non-conforming
  // verifier can throw synchronously. Entries live only while the upstream
  // consume is in flight, so a later deliberate replay still reaches Steward.
  const verification = Promise.resolve()
    .then(() => verify(token, email))
    .finally(() => {
      if (pendingEmailVerifications.get(key) === verification) {
        pendingEmailVerifications.delete(key);
      }
    });
  pendingEmailVerifications.set(key, verification);
  return verification;
}

function describeVerificationError(
  error: unknown,
  t: ReturnType<typeof useCloudT>,
): string {
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
  const attemptedRef = useRef(false);
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
    if (attemptedRef.current) return;
    attemptedRef.current = true;

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

    const finishSuccess = () => {
      const destination = resolveEmailCallbackDestination(
        returnTo,
        consumePendingOAuthReturnTo(),
      );
      successDestinationRef.current = destination;
      clearStoredAppAuthorizeReturnTo();
      if (email) publishStewardEmailLoginComplete(email, destination);
      setStatus("success");
    };

    const token = searchParams.get("token");
    const callbackEmail = searchParams.get("email");
    if (!token || !callbackEmail) {
      setStatus("error");
      setError(
        t("cloud.emailCallback.missingToken", {
          defaultValue: "This sign-in link is missing its token or email.",
        }),
      );
      return;
    }

    void (async () => {
      try {
        // The Steward context's verifyEmailCallback already throws on MFA, so
        // the result here is always a completed { token, refreshToken? }.
        // The module-level single-flight survives StrictMode/provider remounts;
        // a component-local ref does not, and two concurrent POSTs can consume
        // the same one-time link before either mount observes authentication.
        const result = await verifyEmailCallbackSingleFlight(
          auth.verifyEmailCallback,
          token,
          callbackEmail,
        );
        await syncStewardSessionCookie(result.token, result.refreshToken);
        finishSuccess();
      } catch (err) {
        // error-policy:J4 expected rejected/expired one-time links render a
        // distinct recovery message; unexpected failures retain their detail.
        setStatus("error");
        setError(describeVerificationError(err, t));
      }
    })();
  }, [auth, email, returnTo, searchParams, t]);

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
        <p className="max-w-xs text-center text-sm text-muted">{error}</p>
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
