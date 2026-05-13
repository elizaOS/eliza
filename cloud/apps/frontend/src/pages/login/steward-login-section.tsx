import { Alert, AlertDescription, DiscordIcon } from "@elizaos/cloud-ui";
import type { StewardProviders } from "@stwd/sdk";
import { StewardAuth } from "@stwd/sdk";
import { AlertCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { resolveBrowserStewardApiUrl } from "@/lib/steward-url";
import { syncStewardSessionCookie } from "../../lib/steward-session";
import { resolveLoginReturnTo } from "./login-return-to";
import { buildStewardOAuthAuthorizeUrl, type StewardOAuthProvider } from "./steward-oauth-url";
import { StewardWalletProviders } from "./steward-wallet-providers";
import { WalletButtons } from "./wallet-buttons";

// lucide-react v1.x dropped brand icons (Github included). Inline a small
// SVG so the GitHub OAuth button keeps its glyph without pulling another
// icon dep.
const Github = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    aria-hidden="true"
    focusable="false"
  >
    <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.36-3.88-1.36-.52-1.34-1.27-1.7-1.27-1.7-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.69 1.24 3.34.95.1-.74.4-1.24.72-1.53-2.55-.29-5.24-1.27-5.24-5.66 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.45.11-3.02 0 0 .96-.31 3.15 1.17a10.94 10.94 0 0 1 5.74 0c2.18-1.48 3.14-1.17 3.14-1.17.62 1.57.23 2.73.11 3.02.74.8 1.18 1.82 1.18 3.07 0 4.4-2.69 5.36-5.25 5.65.41.36.78 1.07.78 2.16v3.21c0 .31.21.67.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
  </svg>
);

const STEWARD_TENANT_ID = process.env.NEXT_PUBLIC_STEWARD_TENANT_ID || "elizacloud";
const PLAYWRIGHT_TEST_AUTH_ENABLED =
  import.meta.env.VITE_PLAYWRIGHT_TEST_AUTH === "true" ||
  (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH === "true");

type AuthStep = "idle" | "loading" | "email-sent" | "success";
type Provider =
  | "passkey"
  | "email"
  | "google"
  | "discord"
  | "github"
  | "twitter"
  | "ethereum"
  | "solana";

type WalletKind = "ethereum" | "solana";

const DEFAULT_PROVIDERS: StewardProviders = {
  passkey: true,
  email: true,
  siwe: false,
  siws: false,
  google: false,
  discord: false,
  github: false,
  oauth: [],
};

const TEST_PROVIDERS: StewardProviders = {
  ...DEFAULT_PROVIDERS,
  siwe: true,
};

const CALLBACK_REASON_MESSAGES: Record<string, string> = {
  invalid_token: "That login link is invalid. Try signing in again.",
  expired_token: "That login link has expired. Request a new one below.",
  email_mismatch: "The link doesn't match the email you entered. Try again.",
  server_error: "Something went wrong on our end. Try again in a moment.",
};
const CALLBACK_UNKNOWN_MESSAGE = "Couldn't complete sign-in. Try again.";

function hasAnyWalletProvider(providers: StewardProviders): boolean {
  return Boolean(providers.siwe || providers.siws);
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export default function StewardLoginSection() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const pathname = useLocation().pathname;
  const stewardApiUrl = useMemo(() => resolveBrowserStewardApiUrl(), []);

  const auth = useMemo(
    () => new StewardAuth({ baseUrl: stewardApiUrl, tenantId: STEWARD_TENANT_ID }),
    [stewardApiUrl],
  );

  const emailInputRef = useRef<HTMLInputElement>(null);

  const [email, setEmail] = useState("");
  const [step, setStep] = useState<AuthStep>("idle");
  const [loading, setLoading] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const [redirectTo, setRedirectTo] = useState<string | null>(null);
  const [providers, setProviders] = useState<StewardProviders>(() =>
    PLAYWRIGHT_TEST_AUTH_ENABLED ? TEST_PROVIDERS : DEFAULT_PROVIDERS,
  );

  const showWallets = hasAnyWalletProvider(providers);
  const hasOAuthProviders = Boolean(providers.google || providers.discord || providers.github);

  useEffect(() => {
    if (PLAYWRIGHT_TEST_AUTH_ENABLED) return;

    auth
      .getProviders()
      .then(setProviders)
      .catch((providerError) => {
        setError(getErrorMessage(providerError, "Steward provider discovery failed"));
      });
  }, [auth]);

  useEffect(() => {
    const token = searchParams.get("token");
    const refreshToken = searchParams.get("refreshToken");
    if (!token) return;

    try {
      localStorage.setItem("steward_session_token", token);
      if (refreshToken) {
        localStorage.setItem("steward_refresh_token", refreshToken);
      }
    } catch (err) {
      console.warn("[steward] Failed to persist OAuth tokens", err);
    }

    syncStewardSessionCookie(token, refreshToken)
      .then(() => {
        setRedirectTo(resolveLoginReturnTo(searchParams));
      })
      .catch((sessionError) => {
        setCallbackError(getErrorMessage(sessionError, "Could not establish a local session"));
      });
  }, [searchParams]);

  useEffect(() => {
    if (PLAYWRIGHT_TEST_AUTH_ENABLED) return;
    if (searchParams.get("token")) return;
    if (searchParams.get("error")) return;

    let cancelled = false;

    const tryRecoverSession = async () => {
      try {
        const session = auth.getSession();
        if (session?.token) {
          await syncStewardSessionCookie(session.token);
          if (!cancelled) setRedirectTo(resolveLoginReturnTo(searchParams));
          return;
        }

        const refreshed = await auth.refreshSession();
        if (cancelled) return;
        if (refreshed?.token) {
          await syncStewardSessionCookie(refreshed.token);
          if (!cancelled) setRedirectTo(resolveLoginReturnTo(searchParams));
        }
      } catch (sessionError) {
        if (!cancelled) {
          setError(getErrorMessage(sessionError, "Could not restore the local Steward session"));
        }
      }
    };

    void tryRecoverSession();

    return () => {
      cancelled = true;
    };
  }, [auth, searchParams]);

  useEffect(() => {
    const errorCode = searchParams.get("error");
    if (!errorCode) return;

    const reason = searchParams.get("reason");
    const message = (reason && CALLBACK_REASON_MESSAGES[reason]) || CALLBACK_UNKNOWN_MESSAGE;
    setCallbackError(message);

    if (errorCode === "email_auth_failed") {
      emailInputRef.current?.focus();
    }

    const remaining = new URLSearchParams(searchParams.toString());
    remaining.delete("error");
    remaining.delete("reason");
    const qs = remaining.toString();
    navigate(qs ? `${pathname}?${qs}` : pathname, { replace: true });
  }, [pathname, searchParams, navigate]);
  async function handleSuccess(token: string, refreshToken?: string | null) {
    await syncStewardSessionCookie(token, refreshToken);
    setStep("success");
    toast.success("Signed in!");
    setRedirectTo(resolveLoginReturnTo(searchParams));
  }

  async function handlePasskey() {
    if (!email.trim()) {
      setError("Enter your email first");
      return;
    }
    setLoading("passkey");
    setError(null);
    try {
      const result = await auth.signInWithPasskey(email.trim());
      await handleSuccess(result.token, result.refreshToken);
    } catch (e: unknown) {
      setError(getErrorMessage(e, "Passkey failed"));
      setLoading(null);
    }
  }

  async function handleEmail() {
    if (!email.trim()) {
      setError("Enter your email");
      return;
    }
    setLoading("email");
    setError(null);
    try {
      await auth.signInWithEmail(email.trim());
      setStep("email-sent");
      setLoading(null);
    } catch (e: unknown) {
      setError(getErrorMessage(e, "Failed to send"));
      setLoading(null);
    }
  }

  async function handleOAuth(provider: StewardOAuthProvider) {
    setLoading(provider);
    setError(null);
    // Server-side redirect flow. Preserve the current query string on
    // redirect_uri so returnTo (used by /auth/cli-login, app-authorize, etc.)
    // survives the OAuth round-trip. Without this, users signing in from a
    // deep-linked page land on /dashboard instead of the page that redirected
    // them to /login. The authorize endpoint reads `tenant_id` (snake_case);
    // camelCase `tenantId` falls back to the user's personal tenant.
    window.location.href = buildStewardOAuthAuthorizeUrl(provider, window.location.origin, {
      redirectSearch: window.location.search,
      stewardApiUrl,
      stewardTenantId: STEWARD_TENANT_ID,
    });
  }

  if (redirectTo) {
    return <Navigate to={redirectTo} replace />;
  }

  if (step === "success") {
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#FF5800] border-t-transparent" />
        <p className="text-sm text-neutral-400">Redirecting to dashboard...</p>
      </div>
    );
  }

  if (step === "email-sent") {
    return (
      <div className="space-y-4 py-4 text-center">
        <p className="text-white">
          Magic link sent to <strong>{email}</strong>
        </p>
        <p className="text-sm text-neutral-400">Check your inbox and click the link to sign in.</p>
        <button
          type="button"
          className="text-sm text-neutral-500 transition-colors hover:text-white"
          onClick={() => {
            setStep("idle");
            setLoading(null);
          }}
        >
          ← Back to login
        </button>
      </div>
    );
  }

  const isLoading = loading !== null;

  return (
    <div className="space-y-4">
      {callbackError && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{callbackError}</AlertDescription>
        </Alert>
      )}

      <input
        ref={emailInputRef}
        type="email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handlePasskey();
        }}
        disabled={isLoading}
        className="w-full rounded-lg border border-white/10 bg-black/40 px-4 py-3 text-white placeholder:text-neutral-500 focus:border-[#FF5800]/50 focus:outline-none focus:ring-2 focus:ring-[#FF5800]/50 disabled:opacity-50"
        autoComplete="email webauthn"
      />

      <div className="flex gap-2">
        {providers.passkey !== false && (
          <button
            type="button"
            onClick={handlePasskey}
            disabled={isLoading}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[#FF5800] px-4 py-3 font-medium text-white transition-colors hover:bg-[#FF5800]/90 disabled:opacity-50"
          >
            {loading === "passkey" ? <Spinner /> : <PasskeyIcon />} Passkey
          </button>
        )}
        {providers.email !== false && (
          <button
            type="button"
            onClick={handleEmail}
            disabled={isLoading}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-3 font-medium text-white transition-colors hover:bg-white/10 disabled:opacity-50"
          >
            {loading === "email" ? <Spinner /> : <EmailIcon />} Magic Link
          </button>
        )}
      </div>

      {hasOAuthProviders && (
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-white/10" />
          <span className="text-xs text-neutral-500">or continue with</span>
          <div className="h-px flex-1 bg-white/10" />
        </div>
      )}

      {hasOAuthProviders && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {providers.google && (
            <button
              type="button"
              onClick={() => handleOAuth("google")}
              disabled={isLoading}
              className="flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition-colors hover:bg-white/10 disabled:opacity-50"
            >
              {loading === "google" ? <Spinner /> : <GoogleIcon />} Google
            </button>
          )}
          {providers.discord && (
            <button
              type="button"
              onClick={() => handleOAuth("discord")}
              disabled={isLoading}
              className="flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition-colors hover:bg-white/10 disabled:opacity-50"
            >
              {loading === "discord" ? <Spinner /> : <DiscordIcon className="h-4 w-4" />} Discord
            </button>
          )}
          {providers.github && (
            <button
              type="button"
              onClick={() => handleOAuth("github")}
              disabled={isLoading}
              className="flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition-colors hover:bg-white/10 disabled:opacity-50 sm:col-span-2"
            >
              {loading === "github" ? <Spinner /> : <Github className="h-4 w-4" />} GitHub
            </button>
          )}
        </div>
      )}

      {showWallets && (
        <>
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-white/10" />
            <span className="text-xs text-neutral-500">or sign in with a wallet</span>
            <div className="h-px flex-1 bg-white/10" />
          </div>

          <StewardWalletProviders>
            <WalletButtons
              auth={auth}
              disabled={isLoading}
              loadingProvider={
                loading === "ethereum" || loading === "solana" ? (loading as WalletKind) : null
              }
              onLoadingChange={(kind) => setLoading(kind)}
              onSuccess={(result) => handleSuccess(result.token, result.refreshToken)}
              onError={(walletError) => {
                setError(walletError.message || "Wallet sign-in failed");
              }}
            />
          </StewardWalletProviders>
        </>
      )}

      {error && <p className="text-center text-sm text-red-400">{error}</p>}
    </div>
  );
}

function Spinner() {
  return (
    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
  );
}

function GoogleIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

function PasskeyIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z" />
      <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
    </svg>
  );
}

function EmailIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  );
}
