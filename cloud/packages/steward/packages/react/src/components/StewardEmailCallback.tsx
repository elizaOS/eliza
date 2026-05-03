import { useEffect, useRef, useState } from "react";
import { useAuth } from "../hooks/useAuth.js";
import type { StewardEmailCallbackProps } from "../types.js";

type CallbackStep = "loading" | "success" | "error";

/**
 * StewardEmailCallback — Mount on your `/auth/callback` route.
 *
 * Reads `token` and `email` from the URL search params, then calls
 * `verifyEmailCallback` from the auth context to exchange the magic link
 * token for a session.
 *
 * @example
 * // In your router:
 * <Route path="/auth/callback" element={
 *   <StewardEmailCallback
 *     onSuccess={() => navigate("/dashboard")}
 *     redirectTo="/dashboard"
 *   />
 * } />
 */
export function StewardEmailCallback({
  onSuccess,
  onError,
  redirectTo,
}: StewardEmailCallbackProps) {
  const { verifyEmailCallback, isAuthenticated } = useAuth();
  const [step, setStep] = useState<CallbackStep>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const attemptedRef = useRef(false);

  useEffect(() => {
    // Prevent double-fire in React strict mode
    if (attemptedRef.current) return;
    attemptedRef.current = true;

    // Already authenticated, skip verification
    if (isAuthenticated) {
      setStep("success");
      if (redirectTo && typeof window !== "undefined") {
        window.location.href = redirectTo;
      }
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    const email = params.get("email");

    if (!token || !email) {
      const msg = "Missing token or email in callback URL.";
      setErrorMsg(msg);
      setStep("error");
      onError?.(new Error(msg));
      return;
    }

    void (async () => {
      try {
        const result = await verifyEmailCallback(token, email);
        setStep("success");
        onSuccess?.(result);

        if (redirectTo && typeof window !== "undefined") {
          window.location.href = redirectTo;
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setErrorMsg(error.message);
        setStep("error");
        onError?.(error);
      }
    })();
  }, [onError, verifyEmailCallback, redirectTo, onSuccess, isAuthenticated]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRetry = () => {
    attemptedRef.current = false;
    setStep("loading");
    setErrorMsg(null);

    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    const email = params.get("email");

    if (!token || !email) {
      setErrorMsg("Missing token or email in callback URL.");
      setStep("error");
      return;
    }

    void (async () => {
      try {
        const result = await verifyEmailCallback(token, email);
        setStep("success");
        onSuccess?.(result);

        if (redirectTo && typeof window !== "undefined") {
          window.location.href = redirectTo;
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setErrorMsg(error.message);
        setStep("error");
        onError?.(error);
      }
    })();
  };

  if (step === "loading") {
    return (
      <div className="stwd-callback stwd-callback__loading">
        <div className="stwd-loading">Verifying your sign-in link…</div>
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
      <p className="stwd-error-text">{errorMsg ?? "Verification failed."}</p>
      <button className="stwd-btn stwd-btn-secondary" onClick={handleRetry} type="button">
        Retry
      </button>
    </div>
  );
}
