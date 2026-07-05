/**
 * Steward login section for the app-hosted login page.
 *
 * Supports passkey, email magic-link, email-OTP passkey signup, and OAuth
 * (Google / Discord / GitHub), plus the post-redirect OAuth `code` / `#token`
 * consumption + cookie sync.
 *
 * Wallet (SIWE / SIWS) sign-in is currently absent — it was dropped when the
 * old cloud-frontend was folded into `@elizaos/ui` (`4056e0e868`), where the
 * wallet libs weren't yet available. There is no `showWallets` flag; the
 * branch simply wasn't ported. The original blocker is gone (rainbowkit /
 * wagmi / @solana are now deps here, added for billing crypto top-up, and the
 * Steward backend serves `siwe`/`siws` on staging + prod), so re-enabling is a
 * bounded port of the wallet UI from `cloud-frontend@4056e0e868` gated on the
 * live `auth.getProviders()` flags — not a flag flip. Tracked for nubs's call.
 */

import {
  hasStewardAuthedCookie,
  readStoredStewardToken,
  StewardSessionError,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
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
import { DiscordIcon } from "../../../../cloud-ui/components/icons";
import { Alert, AlertDescription } from "../../../../components/primitives";
import { Button } from "../../../../components/ui/button";
import { Input } from "../../../../components/ui/input";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import {
  configuredStewardTenantId,
  DEFAULT_STEWARD_TENANT_ID,
} from "../../../shell/steward-config";
import { resolveBrowserStewardApiUrl } from "../../../shell/steward-url";
import { getErrorMessage } from "../../lib/error-message";
import {
  consumePendingOAuthReturnTo,
  resolveLoginReturnTo,
  storePendingOAuthReturnTo,
} from "../../lib/login-return-to";
import {
  buildStewardOAuthAuthorizeUrl,
  buildStewardOAuthRedirectUri,
  consumeStewardPkceVerifier,
  createStewardPkcePair,
  type StewardOAuthProvider,
  storeStewardPkceVerifier,
} from "../../lib/steward-oauth-url";
import {
  consumeStewardCodeFromQuery,
  consumeStewardTokensFromHash,
  exchangeStewardCodeViaApi,
  hasStewardOAuthCallbackInUrl,
  refreshStewardSessionViaCookie,
  syncStewardSessionCookie,
} from "../../lib/steward-session";

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

const STEWARD_TENANT_ID = configuredStewardTenantId(DEFAULT_STEWARD_TENANT_ID);
const PLAYWRIGHT_TEST_AUTH_ENABLED =
  import.meta.env.VITE_PLAYWRIGHT_TEST_AUTH === "true" ||
  (typeof process !== "undefined" &&
    process.env?.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH === "true");

type AuthStep = "idle" | "loading" | "email-sent" | "otp-entry" | "success";

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
  | "twitter";

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

type LoginTranslator = ReturnType<typeof useCloudT>;

function requireCompletedAuth(
  result: StewardAuthResult | StewardMfaRequiredResult,
): StewardAuthResult {
  if ("mfaRequired" in result) {
    throw new Error("MFA required — not yet supported in this client.");
  }
  return result;
}

/**
 * Message for a failed one-time-code exchange. A 401/403/410 from
 * `steward-nonce-exchange` means the code was rejected — expired, already
 * consumed, or issued for a different tenant (e.g. a prod code replayed against
 * staging). That is benign and recoverable: the working sign-in form renders
 * underneath, so we say "sign in again" instead of surfacing the raw upstream
 * error, which read as a broken login. Genuine faults (5xx/network) still show
 * their real message.
 */
function describeCodeExchangeError(error: unknown, t: LoginTranslator): string {
  if (
    error instanceof StewardSessionError &&
    (error.status === 401 || error.status === 403 || error.status === 410)
  ) {
    return t("cloud.login.callback.codeRejected", {
      defaultValue:
        "That sign-in link expired or was already used. Please sign in again below.",
    });
  }
  return getErrorMessage(error, "Could not complete Eliza Cloud sign-in.");
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
  const t = useCloudT();
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
  // Detected once, synchronously, BEFORE the callback-consuming effect below
  // strips `?code`/`#token` from the URL. While this is true the section shows a
  // terminal "completing sign-in" state instead of re-rendering the provider
  // options underneath the in-flight token exchange — that re-render is what read
  // as the login flashing back to the sign-in options after a successful
  // callback. Cleared only if the exchange fails, so the error + retry surface.
  const [completingCallback, setCompletingCallback] = useState<boolean>(() =>
    PLAYWRIGHT_TEST_AUTH_ENABLED ? false : hasStewardOAuthCallbackInUrl(),
  );
  const [providersLoaded, setProvidersLoaded] = useState(
    PLAYWRIGHT_TEST_AUTH_ENABLED || cachedStewardProviders !== null,
  );
  const [providers, setProviders] = useState<StewardProviders>(
    () => cachedStewardProviders ?? DEFAULT_PROVIDERS,
  );

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
      .finally(() => setProvidersLoaded(true));
  }, [auth]);

  useEffect(() => {
    const code = consumeStewardCodeFromQuery();
    if (code) {
      const codeVerifier = consumeStewardPkceVerifier() ?? undefined;
      exchangeStewardCodeViaApi(code, {
        redirectUri: buildStewardOAuthRedirectUri(window.location.origin),
        tenantId: STEWARD_TENANT_ID,
        codeVerifier,
      })
        .then(async (res) => {
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
          setCompletingCallback(false);
          setCallbackError(describeCodeExchangeError(sessionError, t));
        });
      return;
    }

    const fromHash = consumeStewardTokensFromHash();
    const queryToken = searchParams.get("token");
    const queryRefreshToken = searchParams.get("refreshToken");
    const token = fromHash?.token ?? queryToken;
    const refreshToken = fromHash?.refreshToken ?? queryRefreshToken ?? null;
    if (!token) return;

    try {
      persistStewardToken(token);
    } catch (sessionError) {
      setCompletingCallback(false);
      setCallbackError(
        getErrorMessage(
          sessionError,
          "Could not complete Eliza Cloud sign-in.",
        ),
      );
      return;
    }

    syncStewardSessionCookie(token, refreshToken)
      .then(() => {
        setRedirectTo(
          resolveLoginReturnTo(searchParams, consumePendingOAuthReturnTo()),
        );
      })
      .catch((sessionError) => {
        setCompletingCallback(false);
        setCallbackError(
          getErrorMessage(sessionError, "Could not establish a local session"),
        );
      });
  }, [searchParams, t]);

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
    setCallbackError(getCallbackReasonMessage(reason, t));

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
    persistStewardToken(token);
    await syncStewardSessionCookie(token, refreshToken);
    toast.success("Signed in!");
    setRedirectTo(resolveLoginReturnTo(searchParams));
    setStep("success");
  }

  function isUserCancelled(e: unknown): boolean {
    const msg = getErrorMessage(e, "").toLowerCase();
    return (
      msg.includes("cancel") ||
      msg.includes("notallowed") ||
      msg.includes("not allowed") ||
      msg.includes("aborted") ||
      msg.includes("timed out") ||
      msg.includes("timeout")
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
    } catch {
      await startPasskeySignup();
    }
  }

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
    const host = window.location.hostname.toLowerCase();
    const oauthOrigin = host.endsWith(".pages.dev")
      ? "https://staging.elizacloud.ai"
      : window.location.origin;
    let codeChallenge: string;
    try {
      const pkce = await createStewardPkcePair();
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
      { stewardApiUrl, stewardTenantId: STEWARD_TENANT_ID, codeChallenge },
    );
  }

  if (redirectTo) {
    return <Navigate to={redirectTo} replace />;
  }

  // A completed OAuth/token callback is being exchanged. Hold a terminal
  // "completing sign-in" state (never the provider options) until the exchange
  // resolves into a redirect or an error — so the callback can't flash back to
  // the sign-in options. A callback failure clears this and surfaces
  // `callbackError` below.
  if (completingCallback && !callbackError) {
    return (
      <div className="flex flex-col items-center gap-4 py-8" role="status">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border-strong border-t-accent motion-reduce:animate-none" />
        <p className="text-sm text-muted">
          {t("cloud.login.completingSignIn", {
            defaultValue: "Completing sign-in…",
          })}
        </p>
      </div>
    );
  }

  if (step === "success") {
    return (
      <div className="flex flex-col items-center gap-4 py-8" role="status">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border-strong border-t-accent motion-reduce:animate-none" />
        <p className="text-sm text-muted">
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
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent-subtle text-accent">
          <EmailIcon />
        </div>
        <p className="text-txt-strong">
          {t("cloud.login.magicLinkSent", {
            defaultValue: "Magic link sent to",
          })}{" "}
          <strong className="font-semibold">{email}</strong>
        </p>
        <p className="text-sm text-muted">
          {t("cloud.login.magicLinkHint", {
            defaultValue: "Check your inbox and click the link to sign in.",
          })}
        </p>
        <Button
          variant="ghost"
          type="button"
          className="inline-flex min-h-touch items-center rounded-md px-3 text-sm font-medium text-muted transition-colors hover:text-txt active:scale-[0.98]"
          onClick={() => {
            setStep("idle");
            setLoading(null);
          }}
        >
          ← {t("cloud.login.backToLogin", { defaultValue: "Back to login" })}
        </Button>
      </div>
    );
  }

  if (step === "otp-entry") {
    return (
      <div className="space-y-4 py-4">
        <div className="space-y-1 text-center">
          <p className="font-medium text-txt-strong">
            {t("cloud.login.otp.title", {
              defaultValue: "Set up your passkey",
            })}
          </p>
          <p className="text-sm text-muted">
            {t("cloud.login.otp.subtitle", {
              defaultValue: "Enter the 6-digit code we sent to",
            })}{" "}
            <strong className="font-semibold text-txt">{email}</strong>
          </p>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
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
          className="w-full min-h-touch rounded-md border border-input bg-bg-elevated px-4 py-3 text-center text-lg tracking-[0.5em] text-txt outline-none transition-colors placeholder:tracking-normal placeholder:text-muted hover:border-border-strong disabled:opacity-50"
        />

        <Button
          variant="ghost"
          type="button"
          onClick={handleVerifyOtpAndRegister}
          disabled={loading !== null || otpCode.trim().length < 4}
          className="flex w-full min-h-touch items-center justify-center gap-2 rounded-md bg-accent px-4 py-3 font-semibold text-accent-foreground transition-[background-color,transform] hover:bg-accent-hover active:scale-[0.99] disabled:pointer-events-none disabled:opacity-50"
        >
          {loading === "passkey" ? <Spinner /> : <PasskeyIcon />}{" "}
          {t("cloud.login.otp.createPasskey", {
            defaultValue: "Create passkey",
          })}
        </Button>

        <div className="flex items-center justify-between text-sm">
          <Button
            variant="ghost"
            type="button"
            className="inline-flex min-h-touch items-center rounded-md px-2 font-medium text-muted transition-colors hover:text-txt active:scale-[0.98]"
            onClick={() => {
              setStep("idle");
              setOtpCode("");
              setError(null);
              setLoading(null);
            }}
          >
            ← {t("cloud.login.back", { defaultValue: "Back" })}
          </Button>
          <Button
            variant="ghost"
            type="button"
            className="inline-flex min-h-touch items-center rounded-md px-2 font-medium text-muted transition-colors hover:text-txt active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
            disabled={loading !== null}
            onClick={startPasskeySignup}
          >
            {t("cloud.login.otp.resend", { defaultValue: "Resend code" })}
          </Button>
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
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border-strong border-t-accent motion-reduce:animate-none" />
        <p className="text-sm text-muted">
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

      <Input
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
        className="w-full min-h-touch rounded-md border border-input bg-bg-elevated px-4 py-3 text-txt outline-none transition-colors placeholder:text-muted hover:border-border-strong disabled:opacity-50"
        autoComplete="email webauthn"
      />

      <div className="flex gap-2">
        {providers.passkey !== false && (
          <Button
            variant="ghost"
            type="button"
            onClick={handlePasskey}
            disabled={isLoading}
            className="flex min-h-touch flex-1 items-center justify-center gap-2 rounded-md bg-accent px-4 py-3 font-semibold text-accent-foreground transition-[background-color,transform] hover:bg-accent-hover active:scale-[0.99] disabled:pointer-events-none disabled:opacity-50"
          >
            {loading === "passkey" ? <Spinner /> : <PasskeyIcon />}{" "}
            {t("cloud.login.button.passkey", { defaultValue: "Passkey" })}
          </Button>
        )}
        {providers.email !== false && (
          <Button
            variant="ghost"
            type="button"
            onClick={handleEmail}
            disabled={isLoading}
            className="flex min-h-touch flex-1 items-center justify-center gap-2 rounded-md border border-border-strong bg-bg-elevated px-4 py-3 font-semibold text-txt transition-[background-color,border-color,transform] hover:border-border-hover hover:bg-bg-hover active:scale-[0.99] disabled:pointer-events-none disabled:opacity-50"
          >
            {loading === "email" ? <Spinner /> : <EmailIcon />}{" "}
            {t("cloud.login.button.magicLink", { defaultValue: "Magic Link" })}
          </Button>
        )}
      </div>

      <p className="text-center text-xs text-muted">
        {t("cloud.login.signupHint", {
          defaultValue: "New here? Passkey sets up your account in seconds.",
        })}
      </p>

      {hasOAuthProviders && (
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted">
            {t("cloud.login.orContinueWith", {
              defaultValue: "or continue with",
            })}
          </span>
          <div className="h-px flex-1 bg-border" />
        </div>
      )}

      {hasOAuthProviders && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {providers.google && (
            <Button
              variant="ghost"
              type="button"
              onClick={() => handleOAuth("google")}
              disabled={isLoading}
              className="flex min-h-touch items-center justify-center gap-2 rounded-md border border-border-strong bg-bg-elevated px-4 py-2.5 text-sm font-semibold text-txt transition-[background-color,border-color,transform] hover:border-border-hover hover:bg-bg-hover active:scale-[0.99] disabled:pointer-events-none disabled:opacity-50"
            >
              {loading === "google" ? <Spinner /> : <GoogleIcon />}{" "}
              {t("cloud.login.button.google", { defaultValue: "Google" })}
            </Button>
          )}
          {providers.discord && (
            <Button
              variant="ghost"
              type="button"
              onClick={() => handleOAuth("discord")}
              disabled={isLoading}
              className="flex min-h-touch items-center justify-center gap-2 rounded-md border border-border-strong bg-bg-elevated px-4 py-2.5 text-sm font-semibold text-txt transition-[background-color,border-color,transform] hover:border-border-hover hover:bg-bg-hover active:scale-[0.99] disabled:pointer-events-none disabled:opacity-50"
            >
              {loading === "discord" ? (
                <Spinner />
              ) : (
                <DiscordIcon className="h-4 w-4" />
              )}{" "}
              {t("cloud.login.button.discord", { defaultValue: "Discord" })}
            </Button>
          )}
          {providers.github && (
            <Button
              variant="ghost"
              type="button"
              onClick={() => handleOAuth("github")}
              disabled={isLoading}
              className="flex min-h-touch items-center justify-center gap-2 rounded-md border border-border-strong bg-bg-elevated px-4 py-2.5 text-sm font-semibold text-txt transition-[background-color,border-color,transform] hover:border-border-hover hover:bg-bg-hover active:scale-[0.99] disabled:pointer-events-none disabled:opacity-50 sm:col-span-2"
            >
              {loading === "github" ? (
                <Spinner />
              ) : (
                <Github className="h-4 w-4" />
              )}{" "}
              {t("cloud.login.button.github", { defaultValue: "GitHub" })}
            </Button>
          )}
        </div>
      )}

      {error && (
        <p className="text-center text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70 motion-reduce:animate-none" />
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
