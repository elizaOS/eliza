/**
 * Steward email magic-link callback (public). Verifies the token/email via the
 * Steward auth context, syncs the session cookie, then redirects to the stored
 * app-authorize returnTo (third-party app integration) or /dashboard.
 */

import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  clearStoredAppAuthorizeReturnTo,
  readStoredAppAuthorizeReturnTo,
} from "../../../../cloud-ui/components/auth/authorize-return";
import { BrandButton } from "../../../../cloud-ui/components/brand/brand-button";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import {
  LocalStewardAuthContext,
  StewardAuthProvider,
} from "../../../shell/StewardProvider";
import { DEFAULT_LOGIN_RETURN_TO } from "../../lib/login-return-to";
import { syncStewardSessionCookie } from "../../lib/steward-session";
import { usePageTitle } from "../../lib/use-page-title";

type CallbackStatus = "verifying" | "success" | "error";

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
  const [searchParams] = useSearchParams();
  const auth = useContext(LocalStewardAuthContext);
  const attemptedRef = useRef(false);
  const [status, setStatus] = useState<CallbackStatus>("verifying");
  const [error, setError] = useState<string | null>(null);

  usePageTitle(
    t("cloud.emailCallback.metaTitle", {
      defaultValue: "Email Sign-In | Eliza Cloud",
    }),
  );

  const returnTo = useMemo(readStoredAppAuthorizeReturnTo, []);

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

    const destination = returnTo ?? DEFAULT_LOGIN_RETURN_TO;

    let redirectTimer: ReturnType<typeof setTimeout> | null = null;
    const finishSuccess = () => {
      clearStoredAppAuthorizeReturnTo();
      setStatus("success");
      redirectTimer = setTimeout(() => {
        window.location.replace(destination);
      }, 1500);
    };

    if (auth.isAuthenticated) {
      finishSuccess();
      return () => {
        if (redirectTimer) clearTimeout(redirectTimer);
      };
    }

    const token = searchParams.get("token");
    const email = searchParams.get("email");
    if (!token || !email) {
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
        const result = await auth.verifyEmailCallback(token, email);
        await syncStewardSessionCookie(result.token, result.refreshToken);
        finishSuccess();
      } catch (err) {
        setStatus("error");
        setError(
          err instanceof Error
            ? err.message
            : t("cloud.emailCallback.verifyFailed", {
                defaultValue: "Could not verify this sign-in link.",
              }),
        );
      }
    })();

    return () => {
      if (redirectTimer) clearTimeout(redirectTimer);
    };
  }, [auth, returnTo, searchParams, t]);

  if (status === "error") {
    return (
      <Frame>
        <div className="bg-[#FF5800] p-4 text-black">
          <AlertTriangle className="h-8 w-8" />
        </div>
        <h1 className="text-lg font-semibold text-white">
          {t("cloud.emailCallback.signInFailed", {
            defaultValue: "Sign-in failed",
          })}
        </h1>
        <p className="max-w-xs text-center text-sm text-white/74">{error}</p>
      </Frame>
    );
  }

  if (status === "success") {
    return (
      <Frame>
        <CheckCircle2 className="h-12 w-12 text-white" />
        <h1 className="text-lg font-semibold text-white">
          {t("cloud.emailCallback.signedIn", { defaultValue: "Signed in" })}
        </h1>
        <p className="text-sm text-white/74">
          {t("cloud.emailCallback.returning", {
            defaultValue: "Returning to the app authorization screen...",
          })}
        </p>
        <BrandButton
          className="mt-2"
          onClick={() => returnTo && window.location.assign(returnTo)}
        >
          {t("cloud.emailCallback.continue", {
            defaultValue: "Continue to app authorization",
          })}
        </BrandButton>
      </Frame>
    );
  }

  return (
    <Frame>
      <Loader2 className="h-12 w-12 animate-spin text-[#FF5800]" />
      <h1 className="text-lg font-semibold text-white">
        {t("cloud.emailCallback.verifying", {
          defaultValue: "Verifying sign-in link...",
        })}
      </h1>
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="theme-cloud relative flex min-h-screen w-full flex-col overflow-hidden bg-black font-poppins text-white">
      <div className="relative z-10 flex flex-1 items-center justify-center p-4">
        <div className="w-full max-w-md border border-white/14 bg-black p-8">
          <div className="flex flex-col items-center gap-6">{children}</div>
        </div>
      </div>
    </div>
  );
}
