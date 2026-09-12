/** Completes an OAuth popup handoff without accepting session tokens from URL parameters. */
import { useEffect, useRef, useState } from "react";
import { useAuth } from "../hooks/useAuth.js";
import type { LoginOAuthCallbackProps } from "../types.js";

type CallbackStep = "loading" | "success" | "error";

function callbackParamsFromLocation(location: Location): URLSearchParams {
  const params = new URLSearchParams(location.search);
  const fragment = location.hash.startsWith("#")
    ? location.hash.slice(1)
    : location.hash;
  if (fragment) {
    const hashParams = new URLSearchParams(fragment);
    for (const [key, value] of hashParams) {
      if (!params.has(key)) params.set(key, value);
    }
  }
  return params;
}

/**
 * LoginOAuthCallback — Mount on your OAuth redirect URI route.
 *
 * Handles the code-in-URL flow: the server redirects with `code` and `state`
 * params, and the component calls `onSuccess` with the raw params so the
 * consumer can handle the exchange.
 *
 * @example
 * <Route path="/auth/oauth/callback" element={
 *   <LoginOAuthCallback
 *     provider="google"
 *     onSuccess={(result) => navigate("/dashboard")}
 *     redirectTo="/dashboard"
 *   />
 * } />
 */
export function LoginOAuthCallback({
  onSuccess,
  onError,
  redirectTo,
  provider,
}: LoginOAuthCallbackProps) {
  const auth = useAuth();
  const [step, setStep] = useState<CallbackStep>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const attemptedRef = useRef(false);

  useEffect(() => {
    if (attemptedRef.current) return;
    attemptedRef.current = true;

    // Already authenticated, skip
    if (auth.isAuthenticated) {
      setStep("success");
      if (redirectTo && typeof window !== "undefined") {
        window.location.href = redirectTo;
      }
      return;
    }

    const params = callbackParamsFromLocation(window.location);
    const token = params.get("token");
    const refreshToken = params.get("refreshToken");
    const code = params.get("code");
    const state = params.get("state");
    const errorParam = params.get("error");

    // Server returned an error
    if (errorParam) {
      const description = params.get("error_description") ?? errorParam;
      window.opener?.postMessage(
        { type: "steward-oauth-callback", error: errorParam },
        window.location.origin,
      );
      const err = new Error(description);
      setErrorMsg(description);
      setStep("error");
      onError?.(err);
      return;
    }

    if (token || refreshToken) {
      const msg =
        "Token-in-URL OAuth callbacks are disabled. Use the PKCE code/state callback flow.";
      setErrorMsg(msg);
      setStep("error");
      onError?.(new Error(msg));
      return;
    }

    // Code-in-URL (consumer handles the exchange)
    if (code) {
      window.opener?.postMessage(
        { type: "steward-oauth-callback", code, state: state ?? "" },
        window.location.origin,
      );
      setStep("success");
      onSuccess?.({ code, state: state ?? "" } as {
        code: string;
        state: string;
      });

      if (redirectTo && typeof window !== "undefined") {
        window.location.href = redirectTo;
      }
      return;
    }

    // No recognized params
    const msg = "Missing authentication parameters in callback URL.";
    setErrorMsg(msg);
    setStep("error");
    onError?.(new Error(msg));
  }, [redirectTo, onSuccess, onError, auth.isAuthenticated]);

  if (step === "loading") {
    return (
      <div className="stwd-callback stwd-callback__loading">
        <div className="stwd-loading">
          Completing {provider ? `${provider} ` : ""}sign-in…
        </div>
      </div>
    );
  }

  if (step === "success") {
    return (
      <div className="stwd-callback stwd-callback__success">
        <p>✅ Signed in successfully.</p>
        {redirectTo && <p className="stwd-muted-text">Redirecting…</p>}
      </div>
    );
  }

  return (
    <div className="stwd-callback stwd-callback__error">
      <p className="stwd-error-text">{errorMsg ?? "OAuth sign-in failed."}</p>
      <p className="stwd-muted-text">
        Try signing in again from the login page.
      </p>
    </div>
  );
}
