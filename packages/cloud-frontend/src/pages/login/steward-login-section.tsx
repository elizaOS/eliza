import { resolveBrowserStewardApiUrl } from "@elizaos/cloud-shared/lib/steward-url";
import {
  hasStewardAuthedCookie,
  readStoredStewardToken,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { Alert, AlertDescription, DiscordIcon } from "@elizaos/ui";
import type {
  StewardAuthResult,
  StewardMfaRequiredResult,
  StewardProviders,
} from "@stwd/sdk";
import { StewardAuth } from "@stwd/sdk";
import { AlertCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { toast } from "sonner";
import { useT } from "@/providers/I18nProvider";
import { getErrorMessage } from "../../lib/error-message";
import {
  consumeStewardCodeFromQuery,
  consumeStewardTokensFromHash,
  exchangeStewardCodeViaApi,
  refreshStewardSessionViaCookie,
  syncStewardSessionCookie,
} from "../../lib/steward-session";
import {
  consumePendingOAuthReturnTo,
  resolveLoginReturnTo,
  storePendingOAuthReturnTo,
} from "./login-return-to";
import {
  buildStewardOAuthAuthorizeUrl,
  buildStewardOAuthRedirectUri,
  consumeStewardPkceVerifier,
  createStewardPkcePair,
  type StewardOAuthProvider,
  storeStewardPkceVerifier,
} from "./steward-oauth-url";
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

const STEWARD_TENANT_ID =
  process.env.NEXT_PUBLIC_STEWARD_TENANT_ID || "elizacloud";
const PLAYWRIGHT_TEST_AUTH_ENABLED =
  import.meta.env.VITE_PLAYWRIGHT_TEST_AUTH === "true" ||
  (typeof process !== "undefined" &&
    process.env?.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH === "true");

type AuthStep =
  | "idle"
  | "loading"
  | "email-sent"
  | "otp-entry"
  | "success";

function persistStewardToken(token: string): void {
  writeStoredStewardToken(token);
  if (readStoredStewardToken() !== token) {
    throw new Error(
      "Eliza Cloud sign-in needs browser storage. Enable storage for this site and try again.",
    );
  }
}
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
  twitter: false,
  oauth: [],
};

const TEST_PROVIDERS: StewardProviders = {
  ...DEFAULT_PROVIDERS,
  siwe: true,
};

type LoginTranslator = ReturnType<typeof useT>;

// SDK sign-in methods return `StewardAuthResult | StewardMfaRequiredResult`.
// This client has no MFA-continuation UI, so a step-up challenge can't be
// completed here by this surface. Narrow on the `mfaRequired` discriminant and
// fail before reading token fields off the MFA branch.
function requireCompletedAuth(
  result: StewardAuthResult | StewardMfaRequiredResult,
): StewardAuthResult {
  if ("mfaRequired" in result) {
    throw new Error("MFA required — not yet supported in this client.");
  }
  return result;
}

function getCallbackReasonMessage(
  reason: string | null,
  t: LoginTranslator,
): string {
  switch (reason) {
    case "invalid_token":
      return t("cloud.login.callback.invalidToken", {
        defaultValue: "That login link is invalid. Try signing in again.",
      });
    case "expired_token":
      return t("cloud.login.callback.expiredToken", {
        defaultValue: "That login link has expired. Request a new one below.",
      });
    case "email_mismatch":
      return t("cloud.login.callback.emailMismatch", {
        defaultValue:
          "The link doesn't match the email you entered. Try again.",
      });
    case "server_error":
      return t("cloud.login.callback.serverError", {
        defaultValue: "Something went wrong on our end. Try again in a moment.",
      });
    case "invalid_link":
      return t("cloud.login.callback.invalidLink", {
        defaultValue:
          "We couldn't verify that sign-in link. Request a new one. If it keeps happening, contact support.",
      });
    case "tenant_mismatch":
      return t("cloud.login.callback.tenantMismatch", {
        defaultValue: "That sign-in link is for a different workspace.",
      });
    case "rate_limited":
      return t("cloud.login.callback.rateLimited", {
        defaultValue: "Too many attempts. Wait a moment and try again.",
      });
    case "method_disabled":
      return t("cloud.login.callback.methodDisabled", {
        defaultValue: "That sign-in method isn't enabled for this workspace.",
      });
    case "sso_required":
      return t("cloud.login.callback.ssoRequired", {
        defaultValue: "Your organization requires SSO to sign in.",
      });
    case "tenant_not_found":
    case "tenant_forbidden":
      return t("cloud.login.callback.tenantUnavailable", {
        defaultValue: "Workspace not found or access denied.",
      });
    case "missing_params":
      return t("cloud.login.callback.missingParams", {
        defaultValue: "That sign-in link is incomplete. Request a new one.",
      });
    case "mfa_required":
      return t("cloud.login.callback.mfaRequired", {
        defaultValue:
          "Additional verification is required to finish signing in.",
      });
    default:
      return t("cloud.login.callback.unknown", {
        defaultValue: "Couldn't complete sign-in. Try again.",
      });
  }
}

function hasAnyWalletProvider(providers: StewardProviders): boolean {
  return Boolean(providers.siwe || providers.siws);
}

let cachedStewardProviders: StewardProviders | null = null;
let stewardProvidersPromise: Promise<StewardProviders> | null = null;

function loadStewardProviders(auth: {
  getProviders: () => Promise<StewardProviders>;
}): Promise<StewardProviders> {
  if (cachedStewardProviders) return Promise.resolve(cachedStewardProviders);

  stewardProvidersPromise ??= auth.getProviders().then((loadedProviders) => {
    cachedStewardProviders = loadedProviders;
    stewardProvidersPromise = null;
    return loadedProviders;
  });

  return stewardProvidersPromise;
}

export default function StewardLoginSection() {
  const t = useT();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const pathname = useLocation().pathname;
  const stewardApiUrl = useMemo(() => resolveBrowserStewardApiUrl(), []);

  const auth = useMemo(
    () =>
      new StewardAuth({ baseUrl: stewardApiUrl, tenantId: STEWARD_TENANT_ID }),
    [stewardApiUrl],
  );

  const emailInputRef = useRef<HTMLInputElement>(null);

  const [email, setEmail] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [step, setStep] = useState<AuthStep>("idle");
  const [loading, setLoading] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const [redirectTo, setRedirectTo] = useState<string | null>(null);
  const [walletButtonsMounted, setWalletButtonsMounted] = useState(false);
  const [autoStartWallet, setAutoStartWallet] = useState<WalletKind | null>(
    null,
  );
  const [providersLoaded, setProvidersLoaded] = useState(
    PLAYWRIGHT_TEST_AUTH_ENABLED || cachedStewardProviders !== null,
  );
  const [providers, setProviders] = useState<StewardProviders>(() =>
    PLAYWRIGHT_TEST_AUTH_ENABLED
      ? TEST_PROVIDERS
      : (cachedStewardProviders ?? DEFAULT_PROVIDERS),
  );

  const showWallets = hasAnyWalletProvider(providers);
  const hasOAuthProviders = Boolean(
    providers.google || providers.discord || providers.github,
  );

  useEffect(() => {
    if (PLAYWRIGHT_TEST_AUTH_ENABLED) {
      setProvidersLoaded(true);
      return;
    }

    loadStewardProviders(auth)
      .then(setProviders)
      .catch((providerError: unknown) => {
        stewardProvidersPromise = null;
        setError(
          getErrorMessage(providerError, "Steward provider discovery failed"),
        );
      })
      .finally(() => {
        setProvidersLoaded(true);
      });
  }, [auth]);

  useEffect(() => {
    // Preferred path: server-side nonce exchange. Steward redirects with
    // `?code=<nonce>` (no tokens in URL). POST the code to the cloud-api
    // exchange route, which calls Steward /auth/oauth/exchange server-side
    // and sets HttpOnly cookies. Access + refresh tokens never enter JS.
    const code = consumeStewardCodeFromQuery();
    if (code) {
      // Replay the PKCE verifier stashed before the /authorize redirect so
      // Steward can match it against the bound challenge. Null when the flow
      // predates PKCE (rollout window) or sessionStorage was cleared — the
      // exchange then omits it and Steward surfaces the mismatch.
      const codeVerifier = consumeStewardPkceVerifier() ?? undefined;
      exchangeStewardCodeViaApi(code, {
        redirectUri: buildStewardOAuthRedirectUri(window.location.origin),
        tenantId: STEWARD_TENANT_ID,
        codeVerifier,
      })
        .then(async (res) => {
          // Mirror the JWT into localStorage so `@stwd/react`'s `useAuth()`
          // and `readStewardSessionFromStorage()` see the session on the
          // very next route mount. Without this, OAuth users land back on
          // `/login` after a successful exchange (HttpOnly cookies alone
          // aren't enough — the SPA auth check requires the localStorage
          // copy until that's relaxed). If an older Worker returns only
          // cookies, hydrate through the cookie refresh endpoint before
          // redirecting instead of bouncing into a login loop.
          let token = res?.token;
          if (!token) {
            const refreshed = await refreshStewardSessionViaCookie().catch(
              () => null,
            );
            token = refreshed?.token;
          }
          if (!token) {
            throw new Error(
              "Sign-in completed, but the browser session could not be hydrated. Refresh and try again.",
            );
          }
          persistStewardToken(token);
          window.dispatchEvent(new CustomEvent("steward-token-sync"));
          setRedirectTo(
            resolveLoginReturnTo(searchParams, consumePendingOAuthReturnTo()),
          );
        })
        .catch((sessionError) => {
          setCallbackError(
            getErrorMessage(
              sessionError,
              "Could not complete Eliza Cloud sign-in.",
            ),
          );
        });
      return;
    }

    // Fallback (one-release rollout window): tokens in URL hash (#token=...).
    // Hash never leaves the browser per spec, but tokens still touch JS —
    // preferred only until all consumers have moved to the code flow above.
    const fromHash = consumeStewardTokensFromHash();
    const queryToken = searchParams.get("token");
    const queryRefreshToken = searchParams.get("refreshToken");
    const token = fromHash?.token ?? queryToken;
    const refreshToken = fromHash?.refreshToken ?? queryRefreshToken ?? null;
    if (!token) return;

    try {
      persistStewardToken(token);
    } catch (sessionError) {
      setCallbackError(
        getErrorMessage(
          sessionError,
          "Could not complete Eliza Cloud sign-in.",
        ),
      );
      return;
    }
    // Refresh token is forwarded to the server only so it can be set as the
    // HttpOnly steward-refresh-token cookie — it is NOT persisted in
    // localStorage (XSS-reachable). After first login the HttpOnly cookie
    // is the only persistence; refresh is via /api/auth/steward-refresh.

    syncStewardSessionCookie(token, refreshToken)
      .then(() => {
        setRedirectTo(
          resolveLoginReturnTo(searchParams, consumePendingOAuthReturnTo()),
        );
      })
      .catch((sessionError) => {
        setCallbackError(
          getErrorMessage(sessionError, "Could not establish a local session"),
        );
      });
  }, [searchParams]);

  useEffect(() => {
    if (PLAYWRIGHT_TEST_AUTH_ENABLED) return;
    if (searchParams.get("code")) return;
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

        const storedToken = readStoredStewardToken();
        if (!storedToken && hasStewardAuthedCookie()) {
          const refreshed = await refreshStewardSessionViaCookie();
          if (cancelled) return;
          if (refreshed?.token) {
            writeStoredStewardToken(refreshed.token);
            window.dispatchEvent(new CustomEvent("steward-token-sync"));
            setRedirectTo(resolveLoginReturnTo(searchParams));
          }
          return;
        }

        if (!storedToken) return;

        const refreshed = await auth.refreshSession();
        if (cancelled) return;
        if (refreshed?.token) {
          await syncStewardSessionCookie(refreshed.token);
          if (!cancelled) setRedirectTo(resolveLoginReturnTo(searchParams));
        }
      } catch (sessionError) {
        if (!cancelled) {
          setError(
            getErrorMessage(
              sessionError,
              "Could not restore the local Steward session",
            ),
          );
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
    const message = getCallbackReasonMessage(reason, t);
    setCallbackError(message);

    if (errorCode === "email_auth_failed") {
      emailInputRef.current?.focus();
    }

    const remaining = new URLSearchParams(searchParams.toString());
    remaining.delete("error");
    remaining.delete("reason");
    const qs = remaining.toString();
    navigate(qs ? `${pathname}?${qs}` : pathname, { replace: true });
  }, [pathname, searchParams, navigate, t]);
  async function handleSuccess(token: string, refreshToken?: string | null) {
    await syncStewardSessionCookie(token, refreshToken);
    setStep("success");
    toast.success("Signed in!");
    setRedirectTo(resolveLoginReturnTo(searchParams));
  }

  // Heuristic: did passkey login fail because this email has NO passkey yet
  // (a brand-new or never-enrolled user), vs. a genuine error/cancel? When
  // it's "no credential", we transparently fall into the Privy-style email
  // OTP → passkey-register flow so a first-time user can set up a passkey.
  function isNoPasskeyError(e: unknown): boolean {
    const msg = getErrorMessage(e, "").toLowerCase();
    return (
      msg.includes("no passkey") ||
      msg.includes("no credential") ||
      msg.includes("not found") ||
      msg.includes("404") ||
      msg.includes("no matching")
    );
  }

  // Did the user cancel the WebAuthn prompt? Don't auto-fallback on cancel.
  function isUserCancelled(e: unknown): boolean {
    const msg = getErrorMessage(e, "").toLowerCase();
    return (
      msg.includes("cancel") ||
      msg.includes("notallowed") ||
      msg.includes("aborted") ||
      msg.includes("timed out")
    );
  }

  async function handlePasskey() {
    if (!email.trim()) {
      setError("Enter your email first");
      return;
    }
    setLoading("passkey");
    setError(null);
    try {
      const result = requireCompletedAuth(
        await auth.signInWithPasskey(email.trim()),
      );
      await handleSuccess(result.token, result.refreshToken);
    } catch (e: unknown) {
      // First-time user with no passkey yet → start the OTP-verified passkey
      // signup instead of dead-ending. A real cancel stays an error.
      if (isNoPasskeyError(e) && !isUserCancelled(e)) {
        await startPasskeySignup();
        return;
      }
      setError(getErrorMessage(e, "Passkey failed"));
      setLoading(null);
    }
  }

  // First-time passkey signup, step 1: email a 6-digit OTP and switch to the
  // code-entry step. (Parity with waifu.fun's first-time passkey setup.)
  async function startPasskeySignup() {
    setLoading("passkey");
    setError(null);
    try {
      await auth.sendEmailOtp(email.trim());
      setOtpCode("");
      setStep("otp-entry");
      setLoading(null);
    } catch (e: unknown) {
      setError(getErrorMessage(e, "Couldn't send your code. Try again."));
      setLoading(null);
    }
  }

  // First-time passkey signup, step 2: verify the OTP → emailGrant → register
  // a passkey with that grant (no prior session needed).
  async function handleVerifyOtpAndRegister() {
    const code = otpCode.trim();
    if (code.length < 4) {
      setError("Enter the code from your email");
      return;
    }
    setLoading("passkey");
    setError(null);
    try {
      const { emailGrant } = await auth.verifyEmailOtp(email.trim(), code);
      const result = requireCompletedAuth(
        await auth.addPasskey(email.trim(), { emailGrant }),
      );
      await handleSuccess(result.token, result.refreshToken);
    } catch (e: unknown) {
      if (isUserCancelled(e)) {
        // They dismissed the OS passkey prompt — stay on the step so they can
        // retry without re-entering the code.
        setError("Passkey setup was cancelled. Tap Create passkey to retry.");
      } else {
        setError(getErrorMessage(e, "That code didn't work. Try again."));
      }
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
    // Server-side redirect flow. Keep redirect_uri stable at /login so it
    // matches Steward's exact tenant OAuth allowlist. Do not include returnTo
    // or other volatile login query params in redirect_uri; those can make
    // production logins fail allowlist checks before reaching the provider.
    // The authorize endpoint reads `tenant_id` (snake_case); camelCase
    // `tenantId` falls back to the user's personal tenant.
    // Cloudflare Pages preview deploys live on `*.pages.dev`, whose hashed
    // subdomain is never on the Steward tenant's redirect_uri allowlist.
    // Route OAuth through staging.elizacloud.ai (which is whitelisted, matching
    // the api-fetch-bridge precedent) so sign-in works from previews. The user
    // lands on staging after auth — previews remain unauthenticated visual
    // review surfaces, which is what they're for.
    const host = window.location.hostname.toLowerCase();
    const oauthOrigin = host.endsWith(".pages.dev")
      ? "https://staging.elizacloud.ai"
      : window.location.origin;
    // Steward requires a PKCE challenge on `response_type=code`. Mint the
    // verifier/challenge pair, stash the verifier for the post-redirect
    // /exchange step, and send only the challenge to /authorize. If crypto is
    // unavailable, surface the error instead of redirecting into a guaranteed
    // 400 ("code_challenge is required for response_type=code").
    let codeChallenge: string;
    try {
      const pkce = await createStewardPkcePair();
      // Fail fast if the verifier can't be persisted: redirecting with a
      // challenge we can't later answer would just 401 after a full OAuth
      // round-trip. Better to tell the user upfront.
      if (!storeStewardPkceVerifier(pkce.verifier)) {
        setError(
          "Could not start sign-in — browser storage is unavailable. Enable cookies / site data and try again.",
        );
        setLoading(null);
        return;
      }
      codeChallenge = pkce.challenge;
    } catch (e: unknown) {
      setError(getErrorMessage(e, "Could not start sign-in"));
      setLoading(null);
      return;
    }
    storePendingOAuthReturnTo(searchParams);
    window.location.href = buildStewardOAuthAuthorizeUrl(
      provider,
      oauthOrigin,
      {
        stewardApiUrl,
        stewardTenantId: STEWARD_TENANT_ID,
        codeChallenge,
      },
    );
  }

  function handleWalletIntent(kind: WalletKind) {
    setWalletButtonsMounted(true);
    setAutoStartWallet(kind);
  }

  if (redirectTo) {
    return <Navigate to={redirectTo} replace />;
  }

  if (step === "success") {
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white border-t-transparent" />
        <p className="text-sm text-white/72">
          {t("cloud.login.redirecting", {
            defaultValue: "Redirecting to dashboard...",
          })}
        </p>
      </div>
    );
  }

  if (step === "email-sent") {
    return (
      <div className="space-y-4 py-4 text-center">
        <p className="text-white">
          Magic link sent to <strong>{email}</strong>
        </p>
        <p className="text-sm text-white/72">
          Check your inbox and click the link to sign in.
        </p>
        <button
          type="button"
          className="text-sm text-white/68 transition-colors hover:text-white"
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

  if (step === "otp-entry") {
    return (
      <div className="space-y-4 py-4">
        <div className="space-y-1 text-center">
          <p className="text-white">
            {t("cloud.login.otp.title", {
              defaultValue: "Set up your passkey",
            })}
          </p>
          <p className="text-sm text-white/72">
            {t("cloud.login.otp.subtitle", {
              defaultValue: "Enter the 6-digit code we sent to",
            })}{" "}
            <strong>{email}</strong>
          </p>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          // biome-ignore lint/a11y/noAutofocus: code-entry step expects focus
          autoFocus
          maxLength={8}
          placeholder="123456"
          value={otpCode}
          onChange={(e) =>
            setOtpCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 8))
          }
          onKeyDown={(e) => {
            if (e.key === "Enter") handleVerifyOtpAndRegister();
          }}
          disabled={loading !== null}
          className="w-full border border-white/20 bg-black px-4 py-3 text-center text-lg tracking-[0.5em] text-white placeholder:tracking-normal placeholder:text-white/40 outline-none transition focus:border-white focus:ring-2 focus:ring-[#FF5800]/40 disabled:opacity-50"
        />

        <button
          type="button"
          onClick={handleVerifyOtpAndRegister}
          disabled={loading !== null || otpCode.trim().length < 4}
          className="flex w-full items-center justify-center gap-2 bg-[#FF5800] px-4 py-3 font-semibold text-white transition-colors hover:bg-[#e54f00] disabled:opacity-50"
        >
          {loading === "passkey" ? <Spinner /> : <PasskeyIcon />}{" "}
          {t("cloud.login.otp.createPasskey", {
            defaultValue: "Create passkey",
          })}
        </button>

        <div className="flex items-center justify-between text-sm">
          <button
            type="button"
            className="text-white/68 transition-colors hover:text-white"
            onClick={() => {
              setStep("idle");
              setOtpCode("");
              setError(null);
              setLoading(null);
            }}
          >
            ← {t("cloud.login.back", { defaultValue: "Back" })}
          </button>
          <button
            type="button"
            className="text-white/68 transition-colors hover:text-white disabled:opacity-50"
            disabled={loading !== null}
            onClick={startPasskeySignup}
          >
            {t("cloud.login.otp.resend", { defaultValue: "Resend code" })}
          </button>
        </div>
      </div>
    );
  }

  if (!providersLoaded) {
    return (
      <div
        className="flex flex-col items-center gap-4 py-8"
        role="status"
        aria-busy="true"
        aria-label={t("cloud.login.loadingOptions.aria", {
          defaultValue: "Loading sign-in options",
        })}
      >
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white border-t-transparent" />
        <p className="text-sm text-white/72">
          {t("cloud.login.loadingOptions", {
            defaultValue: "Loading sign-in options...",
          })}
        </p>
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
        placeholder={t("cloud.login.emailPlaceholder", {
          defaultValue: "you@example.com",
        })}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handlePasskey();
        }}
        disabled={isLoading}
        className="w-full border border-white/20 bg-black px-4 py-3 text-white placeholder:text-white/40 outline-none transition focus:border-white focus:ring-2 focus:ring-[#FF5800]/40 disabled:opacity-50"
        autoComplete="email webauthn"
      />

      <div className="flex gap-2">
        {providers.passkey !== false && (
          <button
            type="button"
            onClick={handlePasskey}
            disabled={isLoading}
            className="flex flex-1 items-center justify-center gap-2 bg-[#FF5800] px-4 py-3 font-semibold text-white transition-colors hover:bg-[#e54f00] disabled:opacity-50"
          >
            {loading === "passkey" ? <Spinner /> : <PasskeyIcon />}{" "}
            {t("cloud.login.button.passkey", { defaultValue: "Passkey" })}
          </button>
        )}
        {providers.email !== false && (
          <button
            type="button"
            onClick={handleEmail}
            disabled={isLoading}
            className="flex flex-1 items-center justify-center gap-2 border border-white/30 bg-black/40 px-4 py-3 font-semibold text-white transition-colors hover:bg-white/10 disabled:opacity-50"
          >
            {loading === "email" ? <Spinner /> : <EmailIcon />}{" "}
            {t("cloud.login.button.magicLink", {
              defaultValue: "Magic Link",
            })}
          </button>
        )}
      </div>

      <p className="text-center text-xs leading-5 text-white/62">
        {t("cloud.login.signupHint", {
          defaultValue:
            "New here? Enter your email and tap Passkey — we'll email you a code, then set up your passkey. Magic Link works too.",
        })}
      </p>

      {hasOAuthProviders && (
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-white/14" />
          <span className="text-xs text-white/62">or continue with</span>
          <div className="h-px flex-1 bg-white/14" />
        </div>
      )}

      {hasOAuthProviders && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {providers.google && (
            <button
              type="button"
              onClick={() => handleOAuth("google")}
              disabled={isLoading}
              className="flex items-center justify-center gap-2 border border-white/30 bg-black/40 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-white/10 disabled:opacity-50"
            >
              {loading === "google" ? <Spinner /> : <GoogleIcon />}{" "}
              {t("cloud.login.button.google", { defaultValue: "Google" })}
            </button>
          )}
          {providers.discord && (
            <button
              type="button"
              onClick={() => handleOAuth("discord")}
              disabled={isLoading}
              className="flex items-center justify-center gap-2 border border-white/30 bg-black/40 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-white/10 disabled:opacity-50"
            >
              {loading === "discord" ? (
                <Spinner />
              ) : (
                <DiscordIcon className="h-4 w-4" />
              )}{" "}
              {t("cloud.login.button.discord", { defaultValue: "Discord" })}
            </button>
          )}
          {providers.github && (
            <button
              type="button"
              onClick={() => handleOAuth("github")}
              disabled={isLoading}
              className="flex items-center justify-center gap-2 border border-white/30 bg-black/40 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-white/10 disabled:opacity-50 sm:col-span-2"
            >
              {loading === "github" ? (
                <Spinner />
              ) : (
                <Github className="h-4 w-4" />
              )}{" "}
              {t("cloud.login.button.github", { defaultValue: "GitHub" })}
            </button>
          )}
        </div>
      )}

      {showWallets && (
        <>
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-white/14" />
            <span className="text-xs text-white/62">
              {t("cloud.login.orSignInWallet", {
                defaultValue: "or sign in with a wallet",
              })}
            </span>
            <div className="h-px flex-1 bg-white/14" />
          </div>

          {walletButtonsMounted ? (
            <StewardWalletProviders>
              <WalletButtons
                auth={auth}
                autoStart={autoStartWallet}
                disabled={isLoading}
                loadingProvider={
                  loading === "ethereum" || loading === "solana"
                    ? (loading as WalletKind)
                    : null
                }
                onAutoStartHandled={() => setAutoStartWallet(null)}
                onLoadingChange={(kind) => setLoading(kind)}
                onSuccess={(result) =>
                  handleSuccess(result.token, result.refreshToken)
                }
                onError={(walletError) => {
                  setError(
                    walletError.message ||
                      t("cloud.login.error.walletFailed", {
                        defaultValue: "Wallet sign-in failed",
                      }),
                  );
                }}
              />
            </StewardWalletProviders>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => handleWalletIntent("ethereum")}
                disabled={isLoading}
                className="flex items-center justify-center gap-2 bg-transparent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-white hover:text-black disabled:opacity-50"
              >
                {t("cloud.login.wallet.evm", { defaultValue: "EVM" })}
              </button>
              <button
                type="button"
                onClick={() => handleWalletIntent("solana")}
                disabled={isLoading}
                className="flex items-center justify-center gap-2 bg-transparent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-white hover:text-black disabled:opacity-50"
              >
                {t("cloud.login.wallet.solana", { defaultValue: "Solana" })}
              </button>
            </div>
          )}
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
    <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
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
      aria-hidden="true"
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
      aria-hidden="true"
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
