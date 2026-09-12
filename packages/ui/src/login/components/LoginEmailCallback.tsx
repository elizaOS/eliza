/** Exchanges an email callback token once and removes credentials from the visible browser URL. */
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { useAuth } from "../hooks/useAuth.js";
import type { LoginEmailCallbackProps } from "../types.js";

type CallbackStep = "loading" | "success" | "error";
type CallbackCredentials = { token: string; email: string };
const HISTORY_STATE_KEY = "__stewardEmailCallback";
const inFlightEmailCallbackExchanges = new Map<string, Promise<unknown>>();

function historyState(): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  return window.history?.state && typeof window.history.state === "object"
    ? { ...(window.history.state as Record<string, unknown>) }
    : {};
}

function credentialsFromHistoryState(): CallbackCredentials | null {
  const stored = historyState()[HISTORY_STATE_KEY];
  if (!stored || typeof stored !== "object") return null;
  const record = stored as Record<string, unknown>;
  return typeof record.token === "string" && typeof record.email === "string"
    ? { token: record.token, email: record.email }
    : null;
}

function replaceHistoryState(
  state: Record<string, unknown>,
  url?: string,
): void {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  window.history.replaceState(state, "", url);
}

function clearCredentialsFromHistoryState(): void {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  const nextState = historyState();
  delete nextState[HISTORY_STATE_KEY];
  replaceHistoryState(nextState);
}

/**
 * Remove the magic-link `token` (and `email`) from the visible URL so the
 * one-time token does not linger in browser history, bookmarks, or the
 * Referer header sent to subsequently-loaded resources. We rewrite the
 * current history entry in place via `history.replaceState`; this does not
 * trigger navigation or reload.
 */
function scrubTokenFromUrl(): void {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("token") && !url.searchParams.has("email"))
      return;
    url.searchParams.delete("token");
    url.searchParams.delete("email");
    window.history.replaceState(
      window.history.state,
      "",
      url.pathname + url.search + url.hash,
    );
  } catch {
    // Best effort — never block sign-in on URL cleanup.
  }
}

function callbackCredentialsFromLocation(): CallbackCredentials | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  const email = params.get("email");
  if (token && email) {
    replaceHistoryState({
      ...historyState(),
      [HISTORY_STATE_KEY]: { token, email },
    });
    return { token, email };
  }
  return credentialsFromHistoryState();
}

function emailCallbackExchangeKey(credentials: CallbackCredentials): string {
  return `${credentials.email}\0${credentials.token}`;
}

function emailCallbackExchange<T>(
  credentials: CallbackCredentials,
  start: () => Promise<T>,
): Promise<T> {
  const exchangeKey = emailCallbackExchangeKey(credentials);
  const existing = inFlightEmailCallbackExchanges.get(exchangeKey);
  if (existing) return existing as Promise<T>;

  const exchange = start().then(
    (result) => {
      setTimeout(
        () => inFlightEmailCallbackExchanges.delete(exchangeKey),
        5_000,
      );
      return result;
    },
    (error) => {
      inFlightEmailCallbackExchanges.delete(exchangeKey);
      throw error;
    },
  );
  inFlightEmailCallbackExchanges.set(exchangeKey, exchange);
  return exchange;
}

/**
 * LoginEmailCallback — Mount on your `/auth/callback` route.
 *
 * Reads `token` and `email` from the URL search params, then calls
 * `verifyEmailCallback` from the auth context to exchange the magic link
 * token for a session.
 *
 * @example
 * // In your router:
 * <Route path="/auth/callback" element={
 *   <LoginEmailCallback
 *     onSuccess={() => navigate("/dashboard")}
 *     redirectTo="/dashboard"
 *   />
 * } />
 */
export function LoginEmailCallback({
  onSuccess,
  onError,
  redirectTo,
}: LoginEmailCallbackProps) {
  const { verifyEmailCallback, isAuthenticated } = useAuth();
  const [step, setStep] = useState<CallbackStep>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const attemptedRef = useRef(false);
  // Captured at mount before we scrub the URL, so Retry can re-attempt the
  // exchange even though token/email are no longer in window.location.
  const credsRef = useRef<{ token: string; email: string } | null>(null);

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

    const credentials = callbackCredentialsFromLocation();
    if (!credentials) {
      const msg = "Missing token or email in callback URL.";
      setErrorMsg(msg);
      setStep("error");
      onError?.(new Error(msg));
      return;
    }

    // Capture before scrubbing so the Retry button can re-run the exchange.
    credsRef.current = credentials;

    void (async () => {
      try {
        const result = await emailCallbackExchange(credentials, () =>
          verifyEmailCallback(credentials.token, credentials.email),
        );
        clearCredentialsFromHistoryState();
        setStep("success");
        onSuccess?.(result);

        if (redirectTo && typeof window !== "undefined") {
          window.location.replace(redirectTo);
        } else {
          scrubTokenFromUrl();
        }
      } catch (err) {
        clearCredentialsFromHistoryState();
        scrubTokenFromUrl();
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

    // The URL was scrubbed on the first attempt, so read from the captured
    // credentials rather than the (now token-less) location.
    const token = credsRef.current?.token ?? null;
    const email = credsRef.current?.email ?? null;

    if (!token || !email) {
      setErrorMsg("Missing token or email in callback URL.");
      setStep("error");
      return;
    }

    void (async () => {
      try {
        const credentials = { token, email };
        const result = await emailCallbackExchange(credentials, () =>
          verifyEmailCallback(token, email),
        );
        clearCredentialsFromHistoryState();
        setStep("success");
        onSuccess?.(result);

        if (redirectTo && typeof window !== "undefined") {
          window.location.replace(redirectTo);
        } else {
          scrubTokenFromUrl();
        }
      } catch (err) {
        clearCredentialsFromHistoryState();
        scrubTokenFromUrl();
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
      <Button
        className="stwd-btn stwd-btn-secondary"
        onClick={handleRetry}
        type="button"
      >
        Retry
      </Button>
    </div>
  );
}
