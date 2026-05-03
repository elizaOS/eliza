import { useEffect, useRef, useState } from "react";
import { useAuth } from "../hooks/useAuth.js";
import type { StewardOAuthCallbackProps } from "../types.js";

type CallbackStep = "loading" | "success" | "error";

/**
 * StewardOAuthCallback — Mount on your OAuth redirect URI route.
 *
 * Handles two server-redirect flows:
 *
 * 1. **Token-in-URL flow:** Server completes the OAuth exchange and puts
 *    `token` and `refreshToken` directly in the redirect URL query params.
 *    The component stores them and transitions to success.
 *
 * 2. **Code-in-URL flow:** Server redirects with `code` and `state` params.
 *    Since `handleOAuthCallback` may not exist in the auth context yet,
 *    the component calls `onSuccess` with the raw params so the consumer
 *    can handle the exchange.
 *
 * @example
 * <Route path="/auth/oauth/callback" element={
 *   <StewardOAuthCallback
 *     provider="google"
 *     onSuccess={(result) => navigate("/dashboard")}
 *     redirectTo="/dashboard"
 *   />
 * } />
 */
export function StewardOAuthCallback({
  onSuccess,
  onError,
  redirectTo,
  provider,
}: StewardOAuthCallbackProps) {
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

    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    const refreshToken = params.get("refreshToken");
    const code = params.get("code");
    const state = params.get("state");
    const errorParam = params.get("error");

    // Server returned an error
    if (errorParam) {
      const description = params.get("error_description") ?? errorParam;
      const err = new Error(description);
      setErrorMsg(description);
      setStep("error");
      onError?.(err);
      return;
    }

    // Flow 1: Token-in-URL (server already exchanged the code)
    if (token) {
      // Store the token via the auth context's storage mechanism.
      // We use verifyEmailCallback's storage side-effect by constructing
      // a synthetic auth result. The StewardAuth.storeAndReturn is private,
      // so we store directly and reload the session.
      try {
        if (typeof window !== "undefined" && window.localStorage) {
          window.localStorage.setItem("steward_session_token", token);
          if (refreshToken) {
            window.localStorage.setItem("steward_refresh_token", refreshToken);
          }
        }
      } catch {
        // Storage unavailable, session will be in-memory only
      }

      setStep("success");

      // Build a minimal result for onSuccess
      const user = auth.user ?? { id: "", email: "", walletAddress: "" };
      onSuccess?.({ token, user });

      if (redirectTo && typeof window !== "undefined") {
        // Small delay to let storage persist
        setTimeout(() => {
          window.location.href = redirectTo;
        }, 100);
      }
      return;
    }

    // Flow 2: Code-in-URL (consumer handles the exchange)
    if (code) {
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
  }, [auth.user, redirectTo, onSuccess, onError, auth.isAuthenticated]); // eslint-disable-line react-hooks/exhaustive-deps

  if (step === "loading") {
    return (
      <div className="stwd-callback stwd-callback__loading">
        <div className="stwd-loading">Completing {provider ? `${provider} ` : ""}sign-in…</div>
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
      <p className="stwd-muted-text">Try signing in again from the login page.</p>
    </div>
  );
}
