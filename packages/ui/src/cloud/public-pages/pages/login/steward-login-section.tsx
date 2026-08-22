/**
 * Steward login section for the app-hosted login page.
 *
 * Supports phone OTP when Steward advertises SMS, passkey where browser
 * WebAuthn is actually available, plus email magic-link, OAuth, Telegram,
 * wallets, and the post-redirect OAuth `code` consumption + cookie sync.
 *
 * Wallet (SIWE / SIWS) sign-in is the bounded port of the wallet UI from
 * `cloud-frontend@4056e0e868` (nubs's call, 2026-07-06): gated on the live
 * `auth.getProviders()` flags, rendered by `wallet-buttons.tsx` inside the
 * billing crypto top-up's `StewardWalletProviders` contexts. Both pieces are
 * React.lazy + mounted only on wallet intent, so wagmi/rainbowkit/@solana stay
 * out of the login bundle until a wallet button is clicked. Wallet methods are
 * collapsed behind a single "Continue with a wallet" toggle so email / Magic
 * Link is the only above-the-fold primary action (#19217).
 */

import {
  buildStewardOAuthAuthorizeUrl as buildStewardOAuthAuthorizeUrlCore,
  generateStewardOAuthState,
  hasStewardAuthedCookie,
  peekStewardOAuthState,
  readStoredStewardToken,
  StewardSessionError,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import type {
  StewardAuthResult,
  StewardMfaRequiredResult,
  StewardProviders,
  StewardTelegramLoginPayload,
} from "@stwd/sdk";
import { StewardApiError, StewardAuth } from "@stwd/sdk";
import type { CountryCode } from "libphonenumber-js/min";
import { AlertCircle, Phone } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { toast } from "sonner";
import {
  DiscordIcon,
  TelegramIcon,
} from "../../../../cloud-ui/components/icons";
import { Alert, AlertDescription } from "../../../../components/primitives";
import { Button } from "../../../../components/ui/button";
import { Input } from "../../../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "../../../../components/ui/select";
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
  pollStewardEmailSignInStatus,
  type StewardEmailLoginChallenge,
  StewardEmailLoginError,
  type StewardEmailLoginStatus,
  startStewardEmailLogin,
  verifyStewardEmailSignInCode,
} from "../../lib/steward-email-login";
import { subscribeStewardEmailLoginComplete } from "../../lib/steward-email-login-complete";
import {
  buildStewardOAuthRedirectUri,
  consumeStewardPkceVerifier,
  createStewardPkcePair,
  type StewardOAuthProvider,
  storeStewardPkceVerifier,
} from "../../lib/steward-oauth-url";
import {
  consumeStewardCodeFromQuery,
  consumeStewardOAuthStateFromCallback,
  exchangeStewardCodeViaApi,
  hasStewardOAuthCallbackInUrl,
  recoverStewardEmailSessionViaCookie,
  recoverStewardSessionViaCookie,
  refreshStewardSessionViaCookie,
  stripLegacyTokenHashFromAddressBar,
  syncStewardSessionCookie,
} from "../../lib/steward-session";
import {
  LoginOptionsSkeleton,
  ReservedLoginFrame,
} from "./login-section-skeleton";
import {
  resolveWebPasskeyCapability,
  type WebPasskeyCapability,
} from "./passkey-capability";
import {
  inferPhoneCountry,
  normalizePhoneForCountry,
  PHONE_COUNTRY_OPTIONS,
} from "./phone-country";
import {
  configuredTelegramBotUsername,
  TelegramLoginWidget,
} from "./telegram-login-widget";

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

type AuthStep =
  | "idle"
  | "loading"
  | "email-sent"
  | "sms-code"
  | "otp-entry"
  | "external-success"
  | "success";
type EmailCheckState =
  | "pending"
  | "approved"
  | "expired"
  | "locked"
  | "invalid";

async function persistStewardToken(token: string): Promise<void> {
  await writeStoredStewardToken(token);
  if (readStoredStewardToken() !== token) {
    throw new Error(
      "Eliza Cloud sign-in needs browser storage. Enable storage for this site and try again.",
    );
  }
}

/**
 * `?token=` / `?refreshToken=` query links are not honored (a plain GET link
 * must never plant a session — the `#token=` hash path is likewise stripped
 * unconsumed, see `stripLegacyTokenHashFromAddressBar`). Strip them, plus the
 * consumed OAuth `state` echo, from the address bar
 * immediately so no credential lingers in history, copy/paste, or the reach
 * of third-party scripts booting with the page. Returns true when anything
 * was stripped.
 */
function stripLegacyTokenParamsFromAddressBar(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  let stripped = false;
  for (const key of ["token", "refreshToken", "state"] as const) {
    if (params.has(key)) {
      params.delete(key);
      stripped = true;
    }
  }
  if (!stripped) return false;
  const query = params.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
  );
  return true;
}

type Provider =
  | "passkey"
  | "email"
  | "sms"
  | "google"
  | "discord"
  | "github"
  | "telegram"
  | "twitter"
  | "apple"
  | "ethereum"
  | "solana";

type WalletKind = "ethereum" | "solana";

// Wallet libs (wagmi / rainbowkit / @solana) are heavy; both pieces load only
// when the user expresses wallet intent (see `walletButtonsMounted`).
const StewardWalletProviders = lazy(() =>
  import("../../../billing/wallet/steward-wallet-providers").then((m) => ({
    default: m.StewardWalletProviders,
  })),
);
const WalletButtons = lazy(() =>
  import("./wallet-buttons").then((m) => ({ default: m.WalletButtons })),
);

function hasAnyWalletProvider(providers: StewardProviders): boolean {
  return Boolean(providers.siwe || providers.siws);
}

const STEWARD_OAUTH_PROVIDERS = [
  "google",
  "discord",
  "github",
  "twitter",
  "apple",
] as const satisfies readonly StewardOAuthProvider[];

function isStewardOAuthProviderEnabled(
  providers: StewardProviders,
  provider: StewardOAuthProvider,
): boolean {
  if (providers.oauth?.includes(provider)) return true;
  if (provider === "apple") return false;
  return providers[provider] === true;
}

const DEFAULT_PROVIDERS: StewardProviders = {
  passkey: true,
  email: true,
  sms: false,
  siwe: false,
  siws: false,
  google: false,
  discord: false,
  github: false,
  twitter: false,
  telegram: false,
  oauth: [],
};

type LoginTranslator = ReturnType<typeof useCloudT>;

function requireCompletedAuth(
  result: StewardAuthResult | StewardMfaRequiredResult,
): StewardAuthResult {
  if ("mfaRequired" in result) {
    throw new Error("MFA required. This client does not support it yet.");
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

const AUTH_CODE_RESEND_COOLDOWN_MS = 30_000;
const EMAIL_STATUS_POLL_MS = 3_000;
function sanitizeOneTimeCode(value: string): string {
  return value.replace(/[^0-9]/g, "").slice(0, 6);
}

function challengeExpiresAtMs(challenge: StewardEmailLoginChallenge): number {
  if (typeof challenge.expiresAt === "number") {
    return challenge.expiresAt < 10_000_000_000
      ? challenge.expiresAt * 1000
      : challenge.expiresAt;
  }
  const parsed = Date.parse(challenge.expiresAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function mapChallengeStatus(status: StewardEmailLoginStatus): EmailCheckState {
  switch (status) {
    case "consumed":
      return "approved";
    case "expired":
    case "locked":
    case "invalid":
      return status;
    case "pending":
      return "pending";
  }
}

function describeEmailLoginError(error: unknown, fallback: string): string {
  if (error instanceof StewardEmailLoginError) {
    if (error.status === 429) {
      return "Too many attempts. Wait a moment before trying again.";
    }
    if (error.status === 401 || error.status === 403) {
      return "That code was not accepted. Check the email and try again.";
    }
    if (error.status === 410) {
      return "That sign-in email expired or was already used. Request a new email.";
    }
  }
  return getErrorMessage(error, fallback);
}

let cachedStewardProviders: StewardProviders | null = null;
let stewardProvidersPromise: Promise<StewardProviders> | null = null;

// The provider set is effectively static per deployment, but each SPA load —
// notably the post-OAuth return leg, a second full cold load — used to block
// the option stack on a fresh discovery roundtrip ("Loading sign-in options…",
// #18256). A per-tenant sessionStorage snapshot of the last successful
// discovery lets repeat loads render the real options immediately; the live
// fetch still runs and reconciles, so a config change corrects the form as
// soon as discovery resolves.
const PROVIDERS_SESSION_CACHE_PREFIX = "eliza.steward.providers.v1";

function providersSessionCacheKey(): string {
  return `${PROVIDERS_SESSION_CACHE_PREFIX}:${STEWARD_TENANT_ID}`;
}

function normalizeSessionCachedProviders(
  value: unknown,
): StewardProviders | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const passkey = record.passkey;
  const email = record.email;
  const siwe = record.siwe;
  const siws = record.siws;
  const google = record.google;
  const discord = record.discord;
  const github = record.github;
  const twitter = record.twitter;
  const telegram = record.telegram;
  const oauth = record.oauth;
  if (
    typeof passkey !== "boolean" ||
    typeof email !== "boolean" ||
    typeof siwe !== "boolean" ||
    typeof siws !== "boolean" ||
    typeof google !== "boolean" ||
    typeof discord !== "boolean" ||
    typeof github !== "boolean" ||
    typeof twitter !== "boolean" ||
    !Array.isArray(oauth) ||
    !oauth.every((provider) => typeof provider === "string") ||
    (record.sms !== undefined && typeof record.sms !== "boolean") ||
    (telegram !== undefined && typeof telegram !== "boolean")
  ) {
    return null;
  }
  return {
    passkey,
    email,
    siwe,
    siws,
    google,
    discord,
    github,
    twitter,
    oauth,
    ...(typeof record.sms === "boolean" ? { sms: record.sms } : {}),
    ...(typeof telegram === "boolean" ? { telegram } : {}),
  };
}

function readSessionCachedProviders(): StewardProviders | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(providersSessionCacheKey());
    if (!raw) return null;
    return normalizeSessionCachedProviders(JSON.parse(raw) as unknown);
  } catch (error) {
    // error-policy:J3 a corrupt or inaccessible snapshot is explicitly "no
    // cache" — the section falls back to the discovery skeleton, never to a
    // fake-valid provider set.
    void error;
    return null;
  }
}

function writeSessionCachedProviders(providers: StewardProviders): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      providersSessionCacheKey(),
      JSON.stringify(providers),
    );
  } catch (error) {
    // error-policy:J6 the snapshot is a repeat-load accelerator only; when
    // storage is unavailable (private mode, quota) the next load simply pays
    // the discovery roundtrip again.
    void error;
  }
}

function loadStewardProviders(auth: {
  getProviders: () => Promise<StewardProviders>;
}): Promise<StewardProviders> {
  if (cachedStewardProviders) return Promise.resolve(cachedStewardProviders);
  stewardProvidersPromise ??= auth.getProviders().then((loadedProviders) => {
    cachedStewardProviders = loadedProviders;
    stewardProvidersPromise = null;
    writeSessionCachedProviders(loadedProviders);
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
  const [phoneCountry, setPhoneCountry] = useState<CountryCode>(() =>
    inferPhoneCountry(),
  );
  const telegramBotUsername = useMemo(
    () => configuredTelegramBotUsername(),
    [],
  );

  const auth = useMemo(() => {
    const privateSession = new Map<string, string>();
    return new StewardAuth({
      baseUrl: stewardApiUrl,
      tenantId: STEWARD_TENANT_ID,
      // Steward writes successful exchanges into its configured storage before
      // returning. Keep that intermediate state private: handleSuccess first
      // completes the authoritative Cloud sync (including verified-phone
      // convergence), then publishes once through writeStoredStewardToken.
      storage: {
        getItem: (key) => privateSession.get(key) ?? null,
        setItem: (key, value) => privateSession.set(key, value),
        removeItem: (key) => privateSession.delete(key),
      },
    });
  }, [stewardApiUrl]);

  const emailInputRef = useRef<HTMLInputElement>(null);

  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [emailChallenge, setEmailChallenge] =
    useState<StewardEmailLoginChallenge | null>(null);
  const [emailCheckState, setEmailCheckState] =
    useState<EmailCheckState>("pending");
  // When Steward does not declare which factors the email carried, the code
  // entry stays behind an opt-in disclosure so the waiting screen never
  // asserts a six-digit code the email may not contain (#19213).
  const [showUndeclaredCodeEntry, setShowUndeclaredCodeEntry] = useState(false);
  const [resendRemainingSeconds, setResendRemainingSeconds] = useState(0);
  const [resendAvailableAt, setResendAvailableAt] = useState(0);
  const [step, setStep] = useState<AuthStep>("idle");
  const [loading, setLoading] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPasskeyRecovery, setShowPasskeyRecovery] = useState(false);
  const [telegramIntent, setTelegramIntent] = useState(false);
  const telegramIntentButtonRef = useRef<HTMLButtonElement>(null);
  const telegramRegionRef = useRef<HTMLFieldSetElement>(null);
  // Wallet libs mount only on intent: the first wallet-button click renders
  // the (lazy) providers + buttons and auto-starts that wallet's flow.
  const [walletButtonsMounted, setWalletButtonsMounted] = useState(false);
  const [autoStartWallet, setAutoStartWallet] = useState<WalletKind | null>(
    null,
  );
  // Wallet methods are collapsed behind a single toggle by default so email /
  // Magic Link is the clear above-the-fold primary action (#19217). Expanding
  // reveals the EVM / Solana peer buttons; clicking one mounts the lazy wallet
  // stack as before.
  const [showWalletOptions, setShowWalletOptions] = useState(false);
  // Focus target for the controlled wallet region. After a chain intent locks
  // the disclosure toggle (walletButtonsMounted), keyboard focus must move
  // into this live region so it is not stranded on a newly-disabled control or
  // an unmounted peer button.
  const walletOptionsRegionRef = useRef<HTMLDivElement>(null);
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const [redirectTo, setRedirectTo] = useState<string | null>(null);
  const [externalSuccessDestination, setExternalSuccessDestination] = useState<
    string | null
  >(null);
  // The one in-flight shared-session recovery, keyed by the challenged email
  // and owning its own AbortController. Keying prevents an abandoned email-A
  // challenge's recovery from being handed to a later email-B challenge; the
  // owned controller lets challenge replacement/cancel abort the network work.
  const sharedSessionRecoveryRef = useRef<
    | {
        email: string;
        controller: AbortController;
        promise: ReturnType<typeof recoverStewardEmailSessionViaCookie>;
      }
    | undefined
  >(undefined);
  // Detected once, synchronously, BEFORE the callback-consuming effect below
  // strips `?code`/`#code` from the URL. While this is true the section shows a
  // terminal "completing sign-in" state instead of re-rendering the provider
  // options underneath the in-flight token exchange — that re-render is what read
  // as the login flashing back to the sign-in options after a successful
  // callback. Cleared only if the exchange fails, so the error + retry surface.
  const [completingCallback, setCompletingCallback] = useState<boolean>(() =>
    PLAYWRIGHT_TEST_AUTH_ENABLED ? false : hasStewardOAuthCallbackInUrl(),
  );
  const [providersLoaded, setProvidersLoaded] = useState(
    () =>
      PLAYWRIGHT_TEST_AUTH_ENABLED ||
      cachedStewardProviders !== null ||
      readSessionCachedProviders() !== null,
  );
  const [providers, setProviders] = useState<StewardProviders>(
    () =>
      cachedStewardProviders ??
      readSessionCachedProviders() ??
      DEFAULT_PROVIDERS,
  );
  const [passkeyCapability, setPasskeyCapability] =
    useState<WebPasskeyCapability | null>(
      PLAYWRIGHT_TEST_AUTH_ENABLED
        ? { usable: true, reason: "available" }
        : null,
    );

  const enabledOAuthProviders = STEWARD_OAUTH_PROVIDERS.filter((provider) =>
    isStewardOAuthProviderEnabled(providers, provider),
  );
  const hasIdentityProviders =
    enabledOAuthProviders.length > 0 || providers.telegram === true;
  const showWallets = hasAnyWalletProvider(providers);
  const showPasskey =
    providers.passkey !== false && passkeyCapability?.usable === true;

  const abortSharedEmailSessionRecovery = useCallback(() => {
    const pending = sharedSessionRecoveryRef.current;
    if (!pending) return;
    sharedSessionRecoveryRef.current = undefined;
    pending.controller.abort();
  }, []);

  const recoverSharedEmailSession = useCallback(() => {
    const expected = email.trim().toLowerCase();
    const pending = sharedSessionRecoveryRef.current;
    if (pending?.email === expected && !pending.controller.signal.aborted) {
      return pending.promise;
    }
    // A recovery still pending for a different (abandoned) challenge must
    // never satisfy the current one — replace it with a freshly keyed run.
    pending?.controller.abort();

    const controller = new AbortController();
    const promise = recoverStewardEmailSessionViaCookie(email, {
      signal: controller.signal,
    })
      .then((session) => (controller.signal.aborted ? null : session))
      .finally(() => {
        if (sharedSessionRecoveryRef.current?.controller === controller) {
          sharedSessionRecoveryRef.current = undefined;
        }
      });
    sharedSessionRecoveryRef.current = { email: expected, controller, promise };
    return promise;
  }, [email]);

  // Challenge lifecycle owns the recovery: leaving the email-sent step,
  // switching emails, replacing the challenge (resend), or unmounting aborts
  // the in-flight recovery instead of letting it linger for a later challenge.
  const activeEmailChallengeKey =
    step === "email-sent"
      ? `${email.trim().toLowerCase()}|${emailChallenge?.challengeId ?? ""}`
      : null;
  useEffect(() => {
    if (activeEmailChallengeKey === null) {
      abortSharedEmailSessionRecovery();
      return;
    }
    return () => abortSharedEmailSessionRecovery();
  }, [abortSharedEmailSessionRecovery, activeEmailChallengeKey]);

  useEffect(() => {
    const recoverOAuthIntentAfterHistoryRestore = (
      event: PageTransitionEvent,
    ) => {
      if (!event.persisted) return;
      setLoading((current) => {
        if (
          current === "google" ||
          current === "discord" ||
          current === "github"
        ) {
          return null;
        }
        return current;
      });
    };

    // OAuth owns the current document, but browser Back may revive this React
    // tree from the back/forward cache with its pre-navigation loading state.
    // A fresh load already starts idle; only a persisted history restoration
    // needs to release the provider lock (#20385).
    window.addEventListener("pageshow", recoverOAuthIntentAfterHistoryRestore);
    return () => {
      window.removeEventListener(
        "pageshow",
        recoverOAuthIntentAfterHistoryRestore,
      );
    };
  }, []);

  useEffect(() => {
    if (PLAYWRIGHT_TEST_AUTH_ENABLED) {
      setProvidersLoaded(true);
      return;
    }
    // On the post-OAuth return leg the section shows only the terminal
    // "completing sign-in" state and then redirects — the options never
    // render, so a discovery fetch there is pure waste on the critical path
    // (#18256). If the exchange fails, `completingCallback` clears and this
    // effect re-runs, so the retry surface still gets live discovery.
    if (completingCallback) return;
    let cancelled = false;
    loadStewardProviders(auth)
      .then((loadedProviders) => {
        if (!cancelled) setProviders(loadedProviders);
      })
      .catch((providerError: unknown) => {
        stewardProvidersPromise = null;
        if (cancelled) return;
        // error-policy:J4 with a session-cached provider set already rendered,
        // a failed background reconcile keeps the usable cached form instead
        // of blasting an error over working sign-in options; a first-load
        // failure (nothing rendered yet) still surfaces the error.
        if (readSessionCachedProviders() === null) {
          setError(
            getErrorMessage(providerError, "Steward provider discovery failed"),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setProvidersLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [auth, completingCallback]);

  useEffect(() => {
    if (PLAYWRIGHT_TEST_AUTH_ENABLED) return;

    let cancelled = false;
    resolveWebPasskeyCapability().then((capability) => {
      if (!cancelled) setPasskeyCapability(capability);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const code = consumeStewardCodeFromQuery();
    if (code) {
      // The OAuth `state` echo must exactly match the value stashed at
      // /authorize time, and the PKCE verifier must still be in storage. A
      // callback missing either is a planted or stale link: refusing the
      // exchange is what stops a harvested `?code=` from logging this browser
      // into the attacker's account. The verifier is consumed ONLY when the
      // state matches, so the user's own in-flight flow survives clicking a
      // foreign link.
      const returnedState = consumeStewardOAuthStateFromCallback();
      const expectedState = peekStewardOAuthState();
      if (!returnedState || !expectedState || returnedState !== expectedState) {
        stripLegacyTokenParamsFromAddressBar();
        setCompletingCallback(false);
        setCallbackError(
          t("cloud.login.callbackStateMismatch", {
            defaultValue:
              "This sign-in link is invalid or has expired. Please start sign-in again.",
          }),
        );
        return;
      }
      const codeVerifier = consumeStewardPkceVerifier();
      if (!codeVerifier) {
        setCompletingCallback(false);
        setCallbackError(
          t("cloud.login.callbackVerifierMissing", {
            defaultValue:
              "This sign-in was started in another tab or has expired. Please start sign-in again.",
          }),
        );
        return;
      }
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
          await persistStewardToken(token);
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

    // No OAuth code: drop any legacy credential link from the address bar.
    // Neither `?token=` nor `#token=` is ever consumed — a clicked link must
    // never plant a session (login-CSRF). A stripped credential link (or no
    // callback at all) must not hold the terminal "completing sign-in"
    // state — render the sign-in options.
    stripLegacyTokenParamsFromAddressBar();
    stripLegacyTokenHashFromAddressBar();
    setCompletingCallback(false);
  }, [searchParams, t]);

  useEffect(() => {
    if (PLAYWRIGHT_TEST_AUTH_ENABLED) return;
    if (searchParams.get("code")) return;
    if (searchParams.get("error")) return;

    let cancelled = false;

    const tryRecoverSession = async () => {
      try {
        const storedToken = readStoredStewardToken();
        if (storedToken) {
          try {
            // Session recovery establishes auth only. A pending Telegram claim
            // remains inert until /get-started previews it and the user
            // confirms it explicitly.
            await syncStewardSessionCookie(storedToken, null);
            if (!cancelled) {
              setRedirectTo(resolveLoginReturnTo(searchParams));
            }
            return;
          } catch (storedTokenError) {
            // error-policy:J4 A stale browser token may coexist with a valid
            // HttpOnly refresh cookie. Retry only through the server-owned
            // cookie boundary; never reintroduce a browser refresh token.
            if (!hasStewardAuthedCookie()) throw storedTokenError;
          }
        }

        if (hasStewardAuthedCookie()) {
          const refreshed = await recoverStewardSessionViaCookie();
          if (cancelled) return;
          if (refreshed?.token) {
            await writeStoredStewardToken(refreshed.token);
            window.dispatchEvent(new CustomEvent("steward-token-sync"));
            setRedirectTo(resolveLoginReturnTo(searchParams));
          }
          return;
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
  }, [searchParams]);

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

  useEffect(() => {
    if (
      step !== "email-sent" ||
      !emailChallenge?.challengeId ||
      !emailChallenge.pollSecret
    ) {
      return;
    }
    if (emailCheckState !== "pending") return;

    const { challengeId, pollSecret } = emailChallenge;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const status = await pollStewardEmailSignInStatus(
          { baseUrl: stewardApiUrl, tenantId: STEWARD_TENANT_ID },
          challengeId,
          pollSecret,
        );
        if (cancelled) return;
        const mapped = mapChallengeStatus(status);
        if (mapped === "approved") {
          try {
            const recovered = await recoverSharedEmailSession();
            if (cancelled) return;
            if (recovered) {
              if (recovered.token) {
                await persistStewardToken(recovered.token);
                window.dispatchEvent(new CustomEvent("steward-token-sync"));
              }
              setExternalSuccessDestination(resolveLoginReturnTo(searchParams));
              setEmailCheckState("approved");
              setError(null);
              setStep("external-success");
            } else {
              setEmailCheckState("approved");
              setError(
                "The link was used, but this tab could not restore the shared session. Continue in the tab that opened the link or request a fresh email.",
              );
            }
          } catch (sessionError) {
            // error-policy:J4 a consumed challenge without a recoverable shared
            // session remains visibly nonterminal and offers resend recovery.
            if (!cancelled) {
              setEmailCheckState("approved");
              setError(
                getErrorMessage(
                  sessionError,
                  "The link was used, but this tab could not restore the shared session.",
                ),
              );
            }
          }
          return;
        }
        setEmailCheckState(mapped);
        if (mapped !== "pending") return;
      } catch (pollError) {
        if (!cancelled) {
          setError(
            describeEmailLoginError(
              pollError,
              "Could not check that sign-in email. You can still enter the code.",
            ),
          );
        }
      }
      if (!cancelled) {
        timer = setTimeout(poll, EMAIL_STATUS_POLL_MS);
      }
    };

    timer = setTimeout(poll, EMAIL_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    emailChallenge,
    emailCheckState,
    recoverSharedEmailSession,
    searchParams,
    step,
    stewardApiUrl,
  ]);

  useEffect(() => {
    if (step !== "email-sent" || !email.trim()) return;
    let cancelled = false;
    const unsubscribe = subscribeStewardEmailLoginComplete(email, (message) => {
      void (async () => {
        try {
          const recovered = await recoverSharedEmailSession();
          if (cancelled) return;
          if (!recovered) {
            setEmailCheckState("approved");
            setError(
              "Sign-in finished elsewhere, but this tab could not restore the shared session. Continue in the other tab or request a fresh email.",
            );
            return;
          }
          if (recovered.token) {
            await persistStewardToken(recovered.token);
            window.dispatchEvent(new CustomEvent("steward-token-sync"));
          }
          setExternalSuccessDestination(message.destination);
          setEmailCheckState("approved");
          setError(null);
          setStep("external-success");
        } catch (sessionError) {
          // error-policy:J4 the advisory signal cannot create a signed-in UI;
          // failed authoritative recovery stays visible with resend available.
          if (!cancelled) {
            setEmailCheckState("approved");
            setError(
              getErrorMessage(
                sessionError,
                "Sign-in finished elsewhere, but this tab could not restore the shared session.",
              ),
            );
          }
        }
      })();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [email, recoverSharedEmailSession, step]);

  useEffect(() => {
    const tracksEmailExpiry = step === "email-sent" && emailChallenge !== null;
    if (!tracksEmailExpiry && step !== "sms-code") {
      setResendRemainingSeconds(0);
      return;
    }

    const update = () => {
      const resendMs = Math.max(0, resendAvailableAt - Date.now());
      if (tracksEmailExpiry) {
        const expiryMs = Math.max(
          0,
          challengeExpiresAtMs(emailChallenge) - Date.now(),
        );
        if (expiryMs === 0 && emailCheckState === "pending") {
          setEmailCheckState("expired");
        }
      }
      setResendRemainingSeconds(Math.ceil(resendMs / 1000));
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [emailChallenge, emailCheckState, resendAvailableAt, step]);

  async function handleSuccess(
    token: string,
    refreshToken?: string | null,
    options?: { verifiedPhone: string },
  ) {
    if (options) {
      await syncStewardSessionCookie(token, refreshToken, options);
    } else {
      await syncStewardSessionCookie(token, refreshToken);
    }
    // Publish the browser token only after the authoritative Cloud sync wins.
    // Otherwise StewardProviderRuntime can race a second unhinted sync against
    // phone-account promotion.
    await persistStewardToken(token);
    toast.success("Signed in!");
    setRedirectTo(
      resolveLoginReturnTo(searchParams, consumePendingOAuthReturnTo()),
    );
    setStep("success");
  }

  function isBrowserOwnedWebAuthnFailure(e: unknown, msg: string): boolean {
    return (
      (typeof DOMException !== "undefined" && e instanceof DOMException) ||
      (e instanceof StewardApiError &&
        e.status === 0 &&
        (msg.includes("webauthn authentication") ||
          msg.includes("webauthn registration")))
    );
  }

  function isUserCancelled(e: unknown): boolean {
    const msg = getErrorMessage(e, "").toLowerCase();
    if (!isBrowserOwnedWebAuthnFailure(e, msg)) return false;
    return (
      msg.includes("cancel") ||
      msg.includes("notallowed") ||
      msg.includes("not allowed") ||
      msg.includes("aborted") ||
      msg.includes("timed out") ||
      msg.includes("timeout")
    );
  }

  // UV errors surface when the Steward server or browser WebAuthn layer requires
  // user verification (PIN/biometric) but the assertion didn't satisfy it. They
  // must NOT silently fall through to startPasskeySignup() — the user already
  // has a passkey; sending a setup OTP and re-running addPasskey() hits the same
  // UV constraint and loops. See #18468.
  function isUserVerificationError(e: unknown): boolean {
    const msg = getErrorMessage(e, "").toLowerCase();
    if (!isBrowserOwnedWebAuthnFailure(e, msg)) return false;
    return (
      msg.includes("user verification") ||
      msg.includes("user could not be verified")
    );
  }

  async function handlePasskey() {
    if (!showPasskey) {
      if (providers.email !== false) {
        await handleEmail();
        return;
      }
      setError(
        "Passkeys are not available in this browser. Use Google, Discord, or open this sign-in link on another device.",
      );
      return;
    }
    if (!email.trim()) {
      setError("Enter your email first");
      return;
    }
    setLoading("passkey");
    setError(null);
    setShowPasskeyRecovery(false);
    try {
      const result = requireCompletedAuth(
        await auth.signInWithPasskey(email.trim(), {
          fallbackToRegistration: false,
        }),
      );
      await handleSuccess(result.token, result.refreshToken);
    } catch (e: unknown) {
      // error-policy:J4 authentication failures remain visibly distinct and
      // only the ambiguous browser-owned credential outcome offers recovery.
      if (isUserVerificationError(e)) {
        setError(
          "Passkey sign-in requires device verification (PIN or biometric). Your device may not support this — try Magic Link instead.",
        );
        setLoading(null);
      } else if (
        isUserCancelled(e) ||
        (e instanceof StewardApiError && e.status === 404)
      ) {
        // A discoverable-credential request intentionally cannot reveal whether
        // an account or passkey exists. Chromium reports the same NotAllowedError
        // for an empty credential result and a cancelled prompt, so recovery must
        // remain an explicit user choice instead of silently sending signup mail.
        setShowPasskeyRecovery(true);
        setLoading(null);
      } else {
        setError(getErrorMessage(e, "Passkey sign-in failed. Try again."));
        setLoading(null);
      }
    }
  }

  async function startPasskeySignup() {
    setLoading("passkey");
    setError(null);
    try {
      await auth.sendEmailOtp(email.trim());
      setOtpCode("");
      setShowPasskeyRecovery(false);
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
      // The magic link can open in a new same-origin tab. Persist the pending
      // destination before asking Steward to send it so the callback can
      // resume an onboarding continuation instead of falling back to /join.
      storePendingOAuthReturnTo(searchParams);
      const challenge = await startStewardEmailLogin(
        { baseUrl: stewardApiUrl, tenantId: STEWARD_TENANT_ID },
        email.trim(),
      );
      setEmailChallenge(challenge);
      setEmailCode("");
      setShowUndeclaredCodeEntry(false);
      setEmailCheckState("pending");
      setResendAvailableAt(Date.now() + AUTH_CODE_RESEND_COOLDOWN_MS);
      setStep("email-sent");
      setLoading(null);
    } catch (e: unknown) {
      setError(describeEmailLoginError(e, "Failed to send sign-in email."));
      setLoading(null);
    }
  }

  async function handleSendSms() {
    const normalizedPhone = normalizePhoneForCountry(phone, phoneCountry);
    if (!normalizedPhone) {
      const selectedCountry = PHONE_COUNTRY_OPTIONS.find(
        (option) => option.code === phoneCountry,
      );
      setError(
        t("cloud.login.error.invalidPhone", {
          defaultValue:
            "Enter a valid phone number for {{country}}, or include + and the country code.",
          country: selectedCountry?.name ?? phoneCountry,
        }),
      );
      return;
    }

    setLoading("sms");
    setError(null);
    try {
      await auth.sendSmsOtp(normalizedPhone);
      setPhone(normalizedPhone);
      setSmsCode("");
      setResendAvailableAt(Date.now() + AUTH_CODE_RESEND_COOLDOWN_MS);
      setResendRemainingSeconds(AUTH_CODE_RESEND_COOLDOWN_MS / 1000);
      setStep("sms-code");
    } catch (smsError) {
      // error-policy:J4 Steward transport failures remain a visible login error.
      setError(
        getErrorMessage(smsError, "Couldn't send a text code. Try again."),
      );
    } finally {
      setLoading(null);
    }
  }

  async function handleVerifySms() {
    const code = sanitizeOneTimeCode(smsCode);
    if (code.length !== 6) {
      setError("Enter the six-digit code from the text message.");
      return;
    }

    setLoading("sms");
    setError(null);
    try {
      const result = requireCompletedAuth(await auth.verifySmsOtp(phone, code));
      await handleSuccess(result.token, result.refreshToken, {
        verifiedPhone: phone,
      });
    } catch (smsError) {
      // error-policy:J4 Rejected or failed SMS verification stays recoverable.
      setError(getErrorMessage(smsError, "That code didn't work. Try again."));
    } finally {
      setLoading(null);
    }
  }

  function cancelSmsLogin() {
    setStep("idle");
    setSmsCode("");
    setError(null);
    setLoading(null);
  }

  async function handleVerifyEmailCode() {
    const code = sanitizeOneTimeCode(emailCode);
    if (code.length !== 6) {
      setError("Enter the six-digit code from your email.");
      return;
    }
    setLoading("email");
    setError(null);
    try {
      const result = await verifyStewardEmailSignInCode(
        { baseUrl: stewardApiUrl, tenantId: STEWARD_TENANT_ID },
        email.trim(),
        code,
      );
      if ("mfaRequired" in result) {
        throw new Error(
          "Additional verification is required to finish signing in.",
        );
      }
      await handleSuccess(result.token, result.refreshToken);
    } catch (e: unknown) {
      setError(
        describeEmailLoginError(e, "That code did not work. Try again."),
      );
      setLoading(null);
    }
  }

  function cancelEmailLogin() {
    setStep("idle");
    setEmailChallenge(null);
    setEmailCode("");
    setShowUndeclaredCodeEntry(false);
    setEmailCheckState("pending");
    setError(null);
    setLoading(null);
  }

  async function handleOAuth(provider: StewardOAuthProvider) {
    // This component is the sole hosted /login surface. Keep OAuth in its
    // current document so the callback returns to the same authority that
    // owns loading/error state and consumes the one-time code. A sibling
    // popup leaves this form permanently disabled when that window is closed,
    // blocked, or completes without notifying its opener (#20334).
    setLoading(provider);
    setError(null);
    const host = window.location.hostname.toLowerCase();
    const oauthOrigin = host.endsWith(".pages.dev")
      ? "https://staging.eliza.app"
      : window.location.origin;
    let codeChallenge: string;
    let state: string;
    try {
      const pkce = await createStewardPkcePair();
      state = generateStewardOAuthState();
      // Verifier and state are stashed together: the callback requires the
      // `?state=` echo to match AND the verifier to survive, so a harvested
      // callback URL cannot be replayed in another browser.
      if (!storeStewardPkceVerifier(pkce.verifier, state)) {
        setError(
          "Could not start sign-in. Browser storage is unavailable. Enable cookies / site data and try again.",
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
    const authorizeUrl = buildStewardOAuthAuthorizeUrlCore(
      provider,
      buildStewardOAuthRedirectUri(oauthOrigin),
      {
        stewardApiUrl,
        stewardTenantId: STEWARD_TENANT_ID,
        codeChallenge,
        state,
      },
    );
    window.location.href = authorizeUrl;
  }

  function handleTelegramError(message: string) {
    setError(message);
    setLoading(null);
    setTelegramIntent(false);
    window.setTimeout(
      () => telegramIntentButtonRef.current?.focus({ preventScroll: true }),
      0,
    );
  }

  async function handleTelegramAuth(payload: StewardTelegramLoginPayload) {
    setLoading("telegram");
    setError(null);
    try {
      const result = requireCompletedAuth(
        await auth.signInWithTelegram(payload, {
          tenantId: STEWARD_TENANT_ID,
        }),
      );
      await handleSuccess(result.token, result.refreshToken);
    } catch (telegramError: unknown) {
      // error-policy:J4 Steward or Cloud session failures remain visibly
      // distinct and leave the user on the login surface for a safe retry.
      setError(
        getErrorMessage(telegramError, "Telegram sign-in failed. Try again."),
      );
      setLoading(null);
      window.setTimeout(
        () => telegramRegionRef.current?.focus({ preventScroll: true }),
        0,
      );
    }
  }

  // First wallet click: mount the lazy wallet stack and remember which chain
  // to auto-start once it's up, so the user doesn't have to click twice.
  function handleWalletIntent(kind: WalletKind) {
    setError(null);
    setWalletButtonsMounted(true);
    setAutoStartWallet(kind);
  }

  // Distinct post-intent lock state: the disclosure toggle becomes disabled
  // once the lazy wallet stack is mounted. Move focus into the always-mounted
  // controlled region so keyboard users are not left without a focused target
  // when the peer intent button unmounts and the toggle locks.
  useEffect(() => {
    if (!walletButtonsMounted) return;
    walletOptionsRegionRef.current?.focus({ preventScroll: true });
  }, [walletButtonsMounted]);

  useEffect(() => {
    if (!telegramIntent) return;
    telegramRegionRef.current?.focus({ preventScroll: true });
  }, [telegramIntent]);

  if (redirectTo) {
    return <Navigate to={redirectTo} replace />;
  }

  // A completed OAuth/token callback is being exchanged. Hold a terminal
  // "completing sign-in" state (never the provider options) until the exchange
  // resolves into a redirect or an error — so the callback can't flash back to
  // the sign-in options. A callback failure clears this and surfaces
  // `callbackError` below. The reserved frame keeps the card at the option
  // stack's footprint so a failure resolves in place instead of jumping
  // (#18256).
  if (completingCallback && !callbackError) {
    return (
      <ReservedLoginFrame>
        <div className="flex flex-col items-center gap-4" role="status">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-border-strong border-t-accent motion-reduce:animate-none" />
          <p className="text-sm text-muted">
            {t("cloud.login.completingSignIn", {
              defaultValue: "Completing sign-in…",
            })}
          </p>
        </div>
      </ReservedLoginFrame>
    );
  }

  if (step === "success") {
    return (
      <ReservedLoginFrame>
        <div className="flex flex-col items-center gap-4" role="status">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-border-strong border-t-accent motion-reduce:animate-none" />
          <p className="text-sm text-muted">
            {t("cloud.login.redirecting", {
              defaultValue: "Redirecting to Eliza...",
            })}
          </p>
        </div>
      </ReservedLoginFrame>
    );
  }

  if (step === "sms-code") {
    const resendDisabled = loading !== null || resendRemainingSeconds > 0;

    return (
      <div className="space-y-4 py-4 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent-subtle text-accent">
          <Phone className="size-5" aria-hidden="true" />
        </div>
        <div className="space-y-1">
          <p className="text-base font-semibold text-txt-strong">
            {t("cloud.login.smsCode.title", {
              defaultValue: "Enter the text code",
            })}
          </p>
          <p className="text-sm text-muted">
            {t("cloud.login.smsCode.sentTo", {
              defaultValue: "We sent a six-digit code to",
            })}{" "}
            <strong className="font-semibold text-txt">{phone}</strong>
          </p>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          <label
            htmlFor="sms-sign-in-code"
            className="block text-left text-sm font-medium text-txt"
          >
            {t("cloud.login.smsCode.label", {
              defaultValue: "Six-digit code",
            })}
          </label>
          <Input
            id="sms-sign-in-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={6}
            placeholder="123456"
            value={smsCode}
            onChange={(event) =>
              setSmsCode(sanitizeOneTimeCode(event.target.value))
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") handleVerifySms();
            }}
            disabled={loading !== null}
            className="hosted-signin-focus-emphasis w-full min-h-touch rounded-md border border-input bg-bg-elevated px-4 py-3 text-center text-2xl font-semibold tracking-[0.45em] text-txt outline-none transition-colors placeholder:tracking-normal placeholder:text-muted hover:border-border-strong disabled:opacity-50"
          />
        </div>

        <Button
          variant="ghost"
          type="button"
          onClick={handleVerifySms}
          disabled={loading !== null || smsCode.length !== 6}
          className="hosted-signin-focus-emphasis flex w-full min-h-touch items-center justify-center gap-2 rounded-md bg-accent px-4 py-3 font-semibold text-accent-foreground transition-[background-color,transform] hover:bg-accent-hover hover:text-accent-foreground active:scale-[0.99] disabled:pointer-events-none disabled:bg-accent/80 disabled:text-accent-foreground"
        >
          {loading === "sms" ? (
            <Spinner />
          ) : (
            <Phone className="size-4" aria-hidden="true" />
          )}{" "}
          {t("cloud.login.smsCode.verify", {
            defaultValue: "Verify phone",
          })}
        </Button>

        <div className="flex items-center justify-between text-sm">
          <Button
            variant="ghost"
            type="button"
            className="hosted-signin-focus-emphasis inline-flex min-h-touch items-center rounded-md border border-transparent px-3 font-medium text-muted transition-colors hover:text-txt active:scale-[0.98] disabled:pointer-events-none disabled:text-muted"
            onClick={handleSendSms}
            disabled={resendDisabled}
          >
            {resendRemainingSeconds > 0
              ? `Resend in ${resendRemainingSeconds}s`
              : t("cloud.login.smsCode.resend", {
                  defaultValue: "Resend code",
                })}
          </Button>
          <Button
            variant="ghost"
            type="button"
            className="hosted-signin-focus-emphasis inline-flex min-h-touch items-center rounded-md border border-transparent px-3 font-medium text-muted transition-colors hover:text-txt active:scale-[0.98]"
            onClick={cancelSmsLogin}
          >
            {t("cloud.login.backToLogin", { defaultValue: "Back to login" })}
          </Button>
        </div>
      </div>
    );
  }

  if (step === "external-success") {
    return (
      <ReservedLoginFrame>
        <div
          className="flex flex-col items-center gap-4 text-center"
          role="status"
        >
          <div className="flex size-12 items-center justify-center rounded-full bg-accent-subtle text-accent">
            <EmailIcon />
          </div>
          <p className="text-base font-semibold text-txt-strong">
            {t("cloud.login.emailStatus.signedIn", {
              defaultValue: "Signed in",
            })}
          </p>
          <p className="text-sm text-muted">
            {t("cloud.login.emailStatus.signedInElsewhere", {
              defaultValue:
                "Sign-in finished in another tab. You can continue here or close this tab.",
            })}
          </p>
          <Button
            type="button"
            className="hosted-signin-focus-emphasis min-h-touch w-full rounded-md bg-accent px-4 py-3 font-semibold text-accent-foreground hover:bg-accent-hover hover:text-accent-foreground"
            onClick={() =>
              setRedirectTo(
                externalSuccessDestination ??
                  resolveLoginReturnTo(searchParams),
              )
            }
          >
            {t("cloud.emailCallback.continue", { defaultValue: "Continue" })}
          </Button>
        </div>
      </ReservedLoginFrame>
    );
  }
  if (step === "email-sent") {
    // challengeId/pollSecret are status-polling credentials, not proof the
    // email carried a six-digit code — tenant templates may render the magic
    // link only (#19213). The asserting code UI appears only when Steward
    // explicitly declared code delivery; when it stayed silent the code entry
    // hides behind a non-asserting disclosure; an explicit link-only
    // declaration removes every mention of a code.
    const canVerifyCode = Boolean(
      emailChallenge?.challengeId && emailChallenge.pollSecret,
    );
    const codeEntryMode: "asserted" | "undeclared" | "link-only" =
      !canVerifyCode || emailChallenge?.emailCodeDelivered === false
        ? "link-only"
        : emailChallenge?.emailCodeDelivered === true
          ? "asserted"
          : "undeclared";
    const showCodeEntry =
      codeEntryMode === "asserted" ||
      (codeEntryMode === "undeclared" && showUndeclaredCodeEntry);
    const resendDisabled = loading !== null || resendRemainingSeconds > 0;
    const checkEmailTitle =
      emailCheckState === "approved"
        ? "Link approved"
        : emailCheckState === "expired"
          ? "Email expired"
          : emailCheckState === "locked"
            ? "Too many attempts"
            : emailCheckState === "invalid"
              ? "Email no longer valid"
              : "Check your email";
    const checkEmailMessage =
      emailCheckState === "approved"
        ? "That link was used. For security, request a fresh email to sign in on this device."
        : emailCheckState === "expired"
          ? "That sign-in email expired. Request a new email to continue."
          : emailCheckState === "locked"
            ? "Too many attempts were made. Request a new email in a moment."
            : emailCheckState === "invalid"
              ? "That sign-in email is no longer valid. Request a new email to continue."
              : codeEntryMode === "asserted"
                ? "Open the link on this device or enter the six-digit code we sent."
                : "Check your inbox and open the magic link to sign in.";

    return (
      <div className="space-y-4 py-4 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent-subtle text-accent">
          <EmailIcon />
        </div>
        <div className="space-y-1">
          <p className="text-base font-semibold text-txt-strong">
            {checkEmailTitle}
          </p>
          <p className="text-sm text-muted">
            <strong className="font-semibold text-txt">{email}</strong>
          </p>
        </div>
        <p className="text-sm text-muted">{checkEmailMessage}</p>

        {error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {codeEntryMode === "undeclared" &&
          !showUndeclaredCodeEntry &&
          emailCheckState === "pending" && (
            <Button
              variant="ghost"
              type="button"
              onClick={() => setShowUndeclaredCodeEntry(true)}
              className="inline-flex min-h-touch items-center rounded-md px-3 text-sm font-medium text-muted transition-colors hover:text-txt active:scale-[0.98]"
            >
              {t("cloud.login.emailCode.haveCode", {
                defaultValue: "My email includes a six-digit code",
              })}
            </Button>
          )}

        {showCodeEntry && (
          <div className="space-y-2">
            <label
              htmlFor="email-sign-in-code"
              className="block text-left text-sm font-medium text-txt"
            >
              {t("cloud.login.emailCode.label", {
                defaultValue: "Six-digit code",
              })}
            </label>
            <Input
              id="email-sign-in-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={6}
              placeholder="123456"
              aria-describedby="email-sign-in-code-hint"
              value={emailCode}
              onChange={(e) =>
                setEmailCode(sanitizeOneTimeCode(e.target.value))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") handleVerifyEmailCode();
              }}
              disabled={loading !== null || emailCheckState !== "pending"}
              className="w-full min-h-touch rounded-md border border-input bg-bg-elevated px-4 py-3 text-center text-2xl font-semibold tracking-[0.45em] text-txt outline-none transition-colors placeholder:tracking-normal placeholder:text-muted hover:border-border-strong disabled:opacity-50"
            />
            <p
              id="email-sign-in-code-hint"
              className="text-left text-xs text-muted"
            >
              {t("cloud.login.emailCode.hint", {
                defaultValue:
                  "Use only the current email. A new email replaces the old code.",
              })}
            </p>
          </div>
        )}

        {showCodeEntry && (
          <Button
            variant="ghost"
            type="button"
            onClick={handleVerifyEmailCode}
            disabled={
              loading !== null ||
              emailCode.length !== 6 ||
              emailCheckState !== "pending"
            }
            className="flex w-full min-h-touch items-center justify-center gap-2 rounded-md bg-accent px-4 py-3 font-semibold text-accent-foreground transition-[background-color,transform] hover:bg-accent-hover hover:text-accent-foreground active:scale-[0.99] disabled:pointer-events-none disabled:bg-accent/80 disabled:text-accent-foreground"
          >
            {loading === "email" ? <Spinner /> : <EmailIcon />}{" "}
            {t("cloud.login.emailCode.verify", {
              defaultValue: "Verify code",
            })}
          </Button>
        )}

        {canVerifyCode && emailCheckState === "pending" && (
          <p className="text-xs text-muted" role="status">
            {showCodeEntry
              ? t("cloud.login.emailStatus.pending", {
                  defaultValue: "Waiting for the link or code.",
                })
              : t("cloud.login.emailStatus.pendingLink", {
                  defaultValue: "Waiting for the link.",
                })}
          </p>
        )}

        {emailCheckState === "approved" && (
          <p className="text-xs text-muted" role="status">
            {t("cloud.login.emailStatus.approved", {
              defaultValue:
                "The link was approved elsewhere. This device was not signed in.",
            })}
          </p>
        )}

        <Button
          variant="ghost"
          type="button"
          className="inline-flex min-h-touch items-center rounded-md px-3 text-sm font-medium text-muted transition-colors hover:text-txt active:scale-[0.98] disabled:pointer-events-none disabled:text-muted"
          onClick={handleEmail}
          disabled={resendDisabled}
        >
          {resendRemainingSeconds > 0
            ? `Resend in ${resendRemainingSeconds}s`
            : t("cloud.login.emailCode.resend", {
                defaultValue: "Resend email",
              })}
        </Button>
        <Button
          variant="ghost"
          type="button"
          className="inline-flex min-h-touch items-center rounded-md px-3 text-sm font-medium text-muted transition-colors hover:text-txt active:scale-[0.98]"
          onClick={cancelEmailLogin}
        >
          {t("cloud.login.backToLogin", { defaultValue: "Back to login" })}
        </Button>
      </div>
    );
  }

  if (step === "otp-entry" && showPasskey) {
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
          className="flex w-full min-h-touch items-center justify-center gap-2 rounded-md bg-accent px-4 py-3 font-semibold text-accent-foreground transition-[background-color,transform] hover:bg-accent-hover hover:text-accent-foreground active:scale-[0.99] disabled:pointer-events-none disabled:bg-accent/80 disabled:text-accent-foreground"
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
            className="inline-flex min-h-touch items-center rounded-md px-2 font-medium text-muted transition-colors hover:text-txt active:scale-[0.98] disabled:pointer-events-none disabled:text-muted"
            disabled={loading !== null}
            onClick={startPasskeySignup}
          >
            {t("cloud.login.otp.resend", { defaultValue: "Resend code" })}
          </Button>
        </div>
      </div>
    );
  }

  // Provider discovery in flight: a pulsing skeleton with the final option
  // stack's exact geometry, so the real options materialize in place with no
  // card resize (#18256) instead of replacing a short spinner block.
  if (!providersLoaded) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={t("cloud.login.loadingOptions.aria", {
          defaultValue: "Loading sign-in options",
        })}
      >
        <LoginOptionsSkeleton />
        <span className="sr-only">
          {t("cloud.login.loadingOptions", {
            defaultValue: "Loading sign-in options...",
          })}
        </span>
      </div>
    );
  }

  const isLoading = loading !== null;
  const selectedPhoneCountry =
    PHONE_COUNTRY_OPTIONS.find((option) => option.code === phoneCountry) ??
    PHONE_COUNTRY_OPTIONS.find((option) => option.code === "US");

  return (
    <div className="space-y-4">
      {callbackError && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{callbackError}</AlertDescription>
        </Alert>
      )}

      {providers.sms && (
        <>
          <div className="space-y-2">
            <label
              htmlFor="steward-login-phone"
              className="block text-center text-sm font-medium text-txt"
            >
              {t("cloud.login.phoneLabel", { defaultValue: "Phone number" })}
            </label>
            <div className="flex w-full min-h-touch overflow-hidden rounded-md border border-input bg-bg-elevated transition-colors hover:border-border-strong focus-within:border-border-strong">
              <Select
                name="phone-country"
                value={phoneCountry}
                onValueChange={(value) => setPhoneCountry(value as CountryCode)}
                disabled={isLoading}
              >
                <SelectTrigger
                  aria-label={t("cloud.login.phoneCountryLabel", {
                    defaultValue: "Country calling code",
                  })}
                  className="hosted-signin-focus-emphasis h-auto min-h-touch w-24 shrink-0 rounded-none border-0 border-r border-input bg-bg-elevated px-3 text-sm font-medium text-txt outline-none disabled:opacity-50"
                >
                  <span className="truncate">
                    {selectedPhoneCountry?.code ?? phoneCountry} +
                    {selectedPhoneCountry?.dialCode ?? "1"}
                  </span>
                </SelectTrigger>
                <SelectContent
                  position="popper"
                  align="start"
                  className="!max-h-72 !w-[min(20rem,calc(100vw-2rem))] border-input !bg-bg-elevated text-txt [&_[data-radix-select-viewport]]:!w-full [&_[data-radix-select-viewport]]:!max-w-none"
                >
                  {PHONE_COUNTRY_OPTIONS.map((option) => (
                    <SelectItem
                      key={option.code}
                      value={option.code}
                      className="cursor-pointer data-[highlighted]:bg-bg-hover data-[highlighted]:text-txt-strong"
                    >
                      {option.code} +{option.dialCode} — {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                id="steward-login-phone"
                type="tel"
                name="phone"
                inputMode="tel"
                autoComplete="tel-national"
                placeholder={t("cloud.login.phonePlaceholder", {
                  defaultValue: "Phone number",
                })}
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleSendSms();
                }}
                disabled={isLoading}
                className="hosted-signin-focus-emphasis min-h-touch min-w-0 flex-1 rounded-none border-0 bg-transparent px-4 py-3 text-txt outline-none placeholder:text-muted disabled:opacity-50"
              />
            </div>
          </div>
          <Button
            variant="ghost"
            type="button"
            onClick={handleSendSms}
            disabled={isLoading}
            className="hosted-signin-focus-emphasis flex w-full min-h-touch items-center justify-center gap-2 rounded-md bg-accent px-4 py-3 font-semibold text-accent-foreground transition-[background-color,transform] hover:bg-accent-hover hover:text-accent-foreground active:scale-[0.99] disabled:pointer-events-none disabled:bg-accent/80 disabled:text-accent-foreground"
          >
            {loading === "sms" ? (
              <Spinner />
            ) : (
              <Phone className="size-4" aria-hidden="true" />
            )}{" "}
            {t("cloud.login.button.sms", { defaultValue: "Text me a code" })}
          </Button>
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted">
              {t("cloud.login.orContinueWith", {
                defaultValue: "or continue with",
              })}
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>
        </>
      )}

      <div className="space-y-2">
        <label
          htmlFor="steward-login-email"
          className="block text-center text-sm font-medium text-txt"
        >
          {t("cloud.login.emailLabel", { defaultValue: "Email" })}
        </label>
        <Input
          ref={emailInputRef}
          id="steward-login-email"
          type="email"
          name="email"
          placeholder={t("cloud.login.emailPlaceholder", {
            defaultValue: "you@example.com",
          })}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (showPasskey) {
                handlePasskey();
              } else if (providers.email !== false) {
                handleEmail();
              }
            }
          }}
          disabled={isLoading}
          className="hosted-signin-focus-emphasis w-full min-h-touch rounded-md border border-input bg-bg-elevated px-4 py-3 text-txt outline-none transition-colors placeholder:text-muted hover:border-border-strong disabled:opacity-50"
          // Do NOT add the "webauthn" autocomplete token here. It arms browser
          // conditional-mediation passkey autofill, which prompts for an
          // EXISTING account's discoverable credential the moment a brand-new
          // email is typed, hijacking signup. The explicit Passkey button below
          // still offers email-scoped passkey sign-in via handlePasskey().
          // Port of Steward PR #690.
          autoComplete="email"
        />
      </div>

      <div className="flex gap-2">
        {showPasskey && (
          <Button
            variant="ghost"
            type="button"
            onClick={handlePasskey}
            disabled={isLoading}
            className="flex min-h-touch flex-1 items-center justify-center gap-2 rounded-md border border-transparent bg-accent px-4 py-3 font-semibold text-accent-foreground transition-[background-color,border-color,transform] hover:bg-accent-hover hover:text-accent-foreground active:scale-[0.99] disabled:pointer-events-none disabled:bg-accent/80 disabled:text-accent-foreground"
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
            className="hosted-signin-focus-emphasis flex min-h-touch flex-1 items-center justify-center gap-2 rounded-md border border-border-strong bg-bg-elevated px-4 py-3 font-semibold text-txt transition-[background-color,border-color,transform] hover:border-border-hover hover:bg-bg-hover active:scale-[0.99] disabled:pointer-events-none disabled:border-border/60 disabled:text-muted-strong"
          >
            {loading === "email" ? <Spinner /> : <EmailIcon />}{" "}
            {t("cloud.login.button.magicLink", { defaultValue: "Magic Link" })}
          </Button>
        )}
      </div>

      {!showPasskey &&
      providers.passkey !== false &&
      passkeyCapability === null ? (
        <p className="text-center text-xs text-muted" role="status">
          {t("cloud.login.checkingPasskey", {
            defaultValue:
              "Checking passkey availability. You can continue with Magic Link or another sign-in method now.",
          })}
        </p>
      ) : null}

      {showPasskeyRecovery && (
        <section
          aria-labelledby="passkey-recovery-title"
          className="space-y-3 rounded-md border border-border-strong bg-accent-subtle p-4 text-left"
        >
          <div className="space-y-1">
            <p
              id="passkey-recovery-title"
              className="text-sm font-semibold text-txt-strong"
            >
              {t("cloud.login.passkeyRecovery.title", {
                defaultValue: "Passkey not completed",
              })}
            </p>
            <p className="text-xs leading-relaxed text-muted">
              {t("cloud.login.passkeyRecovery.message", {
                defaultValue:
                  "No passkey was available, or the request was cancelled. Choose how you want to continue.",
              })}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {providers.email !== false && (
              <Button
                variant="ghost"
                type="button"
                onClick={handleEmail}
                disabled={isLoading}
                className="hosted-signin-focus-emphasis min-h-touch rounded-md border border-border-strong bg-bg-elevated px-3 py-2.5 text-sm font-semibold text-txt hover:border-border-hover hover:bg-bg-hover"
              >
                {t("cloud.login.passkeyRecovery.magicLink", {
                  defaultValue: "Use Magic Link",
                })}
              </Button>
            )}
            <Button
              type="button"
              onClick={startPasskeySignup}
              disabled={isLoading}
              className="hosted-signin-focus-emphasis min-h-touch rounded-md bg-accent px-3 py-2.5 text-sm font-semibold text-accent-foreground hover:bg-accent-hover hover:text-accent-foreground"
            >
              {t("cloud.login.passkeyRecovery.setup", {
                defaultValue: "Set up passkey",
              })}
            </Button>
          </div>
        </section>
      )}

      {hasIdentityProviders && (
        <div className="grid grid-cols-2 gap-2">
          {enabledOAuthProviders.map((provider) => (
            <Button
              key={provider}
              variant="ghost"
              type="button"
              aria-label={stewardOAuthProviderLabel(provider)}
              onClick={() => handleOAuth(provider)}
              disabled={isLoading}
              className="hosted-signin-focus-emphasis flex min-h-touch items-center justify-center gap-2 rounded-md border border-border-strong bg-bg-elevated px-4 py-2.5 text-sm font-semibold text-txt transition-[background-color,border-color,transform] hover:border-border-hover hover:bg-bg-hover active:scale-[0.99] disabled:pointer-events-none disabled:border-border/60 disabled:text-muted-strong"
            >
              {loading === provider ? (
                <Spinner />
              ) : (
                <StewardOAuthIcon provider={provider} />
              )}
              {provider === "twitter"
                ? null
                : ` ${stewardOAuthProviderLabel(provider)}`}
            </Button>
          ))}
          {providers.telegram && (
            <Button
              ref={telegramIntentButtonRef}
              variant="ghost"
              type="button"
              aria-expanded={telegramIntent}
              aria-controls="steward-telegram-login-widget"
              onClick={() => {
                setError(null);
                setTelegramIntent(true);
              }}
              disabled={isLoading || telegramIntent}
              className="hosted-signin-focus-emphasis flex min-h-touch items-center justify-center gap-2 rounded-md border border-border-strong bg-bg-elevated px-4 py-2.5 text-sm font-semibold text-txt transition-[background-color,border-color,transform] hover:border-border-hover hover:bg-bg-hover active:scale-[0.99] disabled:pointer-events-none disabled:border-border/60 disabled:text-muted-strong"
            >
              {loading === "telegram" ? (
                <Spinner />
              ) : (
                <TelegramIcon className="h-4 w-4" />
              )}{" "}
              {t("cloud.login.button.telegram", {
                defaultValue: "Telegram",
              })}
            </Button>
          )}
        </div>
      )}

      {providers.telegram && telegramIntent && (
        <fieldset
          id="steward-telegram-login-widget"
          ref={telegramRegionRef}
          aria-label={t("cloud.login.telegramRegion", {
            defaultValue: "Telegram sign-in",
          })}
          tabIndex={-1}
          className="space-y-2 outline-none"
        >
          {telegramBotUsername ? (
            <TelegramLoginWidget
              botUsername={telegramBotUsername}
              disabled={isLoading}
              onAuth={handleTelegramAuth}
              onError={handleTelegramError}
            />
          ) : (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertDescription>
                Telegram sign-in is not configured for this deployment.
              </AlertDescription>
            </Alert>
          )}
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              setTelegramIntent(false);
              window.setTimeout(
                () =>
                  telegramIntentButtonRef.current?.focus({
                    preventScroll: true,
                  }),
                0,
              );
            }}
            disabled={isLoading}
            className="min-h-touch w-full rounded-md px-3 text-sm font-medium text-muted hover:text-txt"
          >
            {t("cloud.login.button.cancelTelegram", {
              defaultValue: "Use another sign-in method",
            })}
          </Button>
        </fieldset>
      )}

      {showWallets && (
        <>
          <Button
            variant="ghost"
            type="button"
            aria-expanded={showWalletOptions || walletButtonsMounted}
            aria-controls="steward-wallet-options"
            onClick={() => setShowWalletOptions((v) => !v)}
            disabled={isLoading || walletButtonsMounted}
            className="hosted-signin-focus-emphasis flex min-h-touch w-full items-center justify-center gap-2 rounded-md border border-border-strong bg-bg-elevated px-4 py-2.5 text-sm font-semibold text-txt transition-[background-color,border-color,transform] hover:border-border-hover hover:bg-bg-hover active:scale-[0.99] disabled:pointer-events-none disabled:border-border/60 disabled:text-muted-strong"
          >
            {walletButtonsMounted
              ? t("cloud.login.walletOptions", {
                  defaultValue: "Wallet options",
                })
              : showWalletOptions
                ? t("cloud.login.collapseWalletOptions", {
                    defaultValue: "Collapse wallet options",
                  })
                : t("cloud.login.moreOptions", {
                    defaultValue: "Continue with a wallet",
                  })}
          </Button>

          <div
            id="steward-wallet-options"
            ref={walletOptionsRegionRef}
            tabIndex={-1}
            hidden={!showWalletOptions && !walletButtonsMounted}
          >
            {(showWalletOptions || walletButtonsMounted) &&
              (walletButtonsMounted ? (
                <Suspense
                  fallback={
                    <div className="flex min-h-touch items-center justify-center py-2.5">
                      <Spinner />
                    </div>
                  }
                >
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
                </Suspense>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {providers.siwe && (
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => handleWalletIntent("ethereum")}
                      disabled={isLoading}
                      className="hosted-signin-focus-emphasis flex min-h-touch items-center justify-center gap-2 rounded-md border border-border-strong bg-bg-elevated px-4 py-2.5 text-sm font-semibold text-txt transition-[background-color,border-color,transform] hover:border-border-hover hover:bg-bg-hover active:scale-[0.99] disabled:pointer-events-none disabled:border-border/60 disabled:text-muted-strong"
                    >
                      {t("cloud.login.wallet.evm", {
                        defaultValue: "EVM wallet",
                      })}
                    </Button>
                  )}
                  {providers.siws && (
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => handleWalletIntent("solana")}
                      disabled={isLoading}
                      className="hosted-signin-focus-emphasis flex min-h-touch items-center justify-center gap-2 rounded-md border border-border-strong bg-bg-elevated px-4 py-2.5 text-sm font-semibold text-txt transition-[background-color,border-color,transform] hover:border-border-hover hover:bg-bg-hover active:scale-[0.99] disabled:pointer-events-none disabled:border-border/60 disabled:text-muted-strong"
                    >
                      {t("cloud.login.wallet.solana", {
                        defaultValue: "Solana wallet",
                      })}
                    </Button>
                  )}
                </div>
              ))}
          </div>
        </>
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

function stewardOAuthProviderLabel(provider: StewardOAuthProvider): string {
  switch (provider) {
    case "google":
      return "Google";
    case "discord":
      return "Discord";
    case "github":
      return "GitHub";
    case "twitter":
      return "X";
    case "apple":
      return "Apple";
  }
}

function StewardOAuthIcon({ provider }: { provider: StewardOAuthProvider }) {
  switch (provider) {
    case "google":
      return <GoogleIcon />;
    case "discord":
      return <DiscordIcon className="h-4 w-4" />;
    case "github":
      return <Github className="h-4 w-4" />;
    case "twitter":
      return <XIcon />;
    case "apple":
      return <AppleIcon />;
  }
}

function AppleIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.79 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.53 4.1v-.01ZM12.03 7.25C11.88 5.02 13.69 3.18 15.77 3c.29 2.58-2.34 4.5-3.74 4.25Z" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
    </svg>
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
