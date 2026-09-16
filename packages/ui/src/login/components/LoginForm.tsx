/** Presents configured login methods and routes their challenges through the shared authentication context. */
import type { LoginAuthResult, LoginMfaRequiredResult } from "@elizaos/login";
import type React from "react";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  DiscordIcon,
  EmailIcon,
  EthereumIcon,
  FarcasterIcon,
  GitHubIcon,
  GoogleIcon,
  PasskeyIcon,
  TelegramIcon,
  XIcon,
} from "../icons/index.js";
import {
  getEvmWalletPanel,
  getSolanaWalletPanel,
  type WalletPanelLoader,
} from "../internal/walletPanelRegistry.js";
import { LoginAuthContext } from "../provider.js";
import type { LoginFormProps } from "../types.js";
import type { WalletLoginPanelProps } from "./WalletLogin.js";

type LoginStep =
  | "idle"
  | "loading"
  | "email-sent"
  | "passkey-fallback-pending"
  | "error";
type SmsStep = "idle" | "sent";
type PhoneOtpChannel = "sms" | "whatsapp";
type LoadingButton =
  | "passkey"
  | "email"
  | "sms"
  | "sms-verify"
  | "whatsapp"
  | "whatsapp-verify"
  | "guest"
  | "guest-upgrade"
  | "guest-delete"
  | "google"
  | "discord"
  | "github"
  | "telegram"
  | "farcaster"
  | "twitter"
  | "siwe"
  | "wallet-evm"
  | "wallet-sol"
  | null;

type WalletPanelComponent = React.ComponentType<WalletLoginPanelProps>;

/**
 * sessionStorage flag set when a passkey login fails because the credential
 * lives on a different relying party (e.g. user has a passkey registered on
 * elizacloud.ai but is now signing in on waifu.fun). After the magic-link
 * sign-in completes the app can use this flag to surface a
 * "register a passkey on this device" prompt rather than silently leaving
 * the user without one. Consumers read via PASSKEY_ENROLL_PROMPT_KEY.
 */
export const PASSKEY_ENROLL_PROMPT_KEY = "stwd:enroll-passkey-after-login";

/**
 * Heuristic check: did this passkey attempt fail because the browser had no
 * usable credential for this relying party (a common cross-domain scenario),
 * or because the user cancelled / dismissed the prompt? In both cases the
 * right next move is the same: fall back to a magic-link sign-in. We are
 * deliberately permissive here — the magic-link fallback is non-destructive,
 * and the worst case is we send an email the user could have avoided.
 */
function isRecoverablePasskeyFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("cancelled") ||
    msg.includes("canceled") ||
    msg.includes("timed out") ||
    msg.includes("not allowed") ||
    msg.includes("notallowederror") ||
    msg.includes("no credentials") ||
    msg.includes("invalidstateerror")
  );
}

/**
 * Adapt a `<WalletLogin*>` panel `onSuccess` callback (which yields a full
 * `LoginAuthResult` plus a `kind` discriminator) to the shape consumers of
 * `<LoginForm>` expect (`{ token, user }`). Exported for direct unit
 * testing of the bubble contract.
 */
export function composeWalletSuccess(
  onSuccess?: LoginFormProps["onSuccess"],
): NonNullable<WalletLoginPanelProps["onSuccess"]> {
  return (result, _kind) => {
    if ("token" in result) {
      onSuccess?.({ token: result.token, user: result.user });
    } else {
      onSuccess?.(result);
    }
  };
}

/**
 * Adapt a `<WalletLogin*>` panel `onError` callback to the shape that
 * `<LoginForm>` consumers expect. Exported for direct unit testing.
 */
export function composeWalletError(
  onError?: LoginFormProps["onError"],
): NonNullable<WalletLoginPanelProps["onError"]> {
  return (err, _kind) => {
    onError?.(err);
  };
}

/**
 * Lazily load a `<WalletLogin*>` panel only when it is actually needed.
 *
 * The panels live in `WalletLogin.EVM.tsx` / `WalletLogin.Solana.tsx` so their
 * `wagmi` / `@solana/*` peer-dep imports stay off the root bundle. We mirror
 * the pattern from `<WalletLogin>` itself: dynamic import, fallback while
 * loading. We avoid `React.lazy` here because `renderToString` does not
 * support Suspense.
 */
function useDynamicWalletPanel(
  enabled: boolean,
  loader: (() => Promise<{ default: WalletPanelComponent }>) | undefined,
): WalletPanelComponent | null {
  const [Panel, setPanel] = useState<WalletPanelComponent | null>(null);
  useEffect(() => {
    if (!enabled || !loader) return;
    let cancelled = false;
    loader().then((mod) => {
      if (!cancelled) setPanel(() => mod.default);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, loader]);
  return Panel;
}

/**
 * LoginForm, drop-in auth widget for elizaOS-powered apps.
 *
 * Must be used inside a `<LoginProvider auth={{ baseUrl: "..." }}>`.
 *
 * Supports:
 *   - Passkey (WebAuthn), browser only
 *   - Email magic link
 *   - Wallet sign-in (SIWE / SIWS), via `showWallets`. Requires the matching
 *     wallet provider (see `EVMWalletProvider`, `SolanaWalletProvider` from
 *     `@elizaos/ui`).
 *   - Google OAuth (popup)
 *   - Discord OAuth (popup)
 *
 * @example
 * <LoginProvider client={client} agentId="..." auth={{ baseUrl: "http://localhost:3200" }}>
 *   <LoginForm
 *     variant="card"
 *     title="welcome back"
 *     showWallets
 *     showGoogle
 *     showDiscord
 *     onSuccess={() => console.log("signed in")}
 *   />
 * </LoginProvider>
 */
export function LoginForm({
  onSuccess,
  onError,
  showPasskey = true,
  showEmail = true,
  showSms = true,
  showWhatsApp = true,
  showGuest = true,
  guestSignInLabel = "continue as guest",
  guestUpgradeLabel = "upgrade guest",
  guestDeleteLabel = "delete guest",
  guestEmailPlaceholder = "you@example.com",
  guestTokenPlaceholder = "email verification token",
  onGuestDeleted,
  showSIWE = false,
  showWallets = false,
  showGoogle = true,
  showDiscord = true,
  showGithub = true,
  showTwitter = true,
  showTelegram = true,
  getTelegramLoginPayload,
  showFarcaster = true,
  getFarcasterLoginPayload,
  variant = "card",
  logo,
  title,
  subtitle,
  tenantId,
  className,
}: LoginFormProps) {
  const ctx = useContext(LoginAuthContext);

  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [guestUpgradeEmail, setGuestUpgradeEmail] = useState("");
  const [guestUpgradeToken, setGuestUpgradeToken] = useState("");
  const [smsStep, setSmsStep] = useState<SmsStep>("idle");
  const [phoneOtpChannel, setPhoneOtpChannel] =
    useState<PhoneOtpChannel | null>(null);
  const [step, setStep] = useState<LoginStep>("idle");
  const [loadingBtn, setLoadingBtn] = useState<LoadingButton>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Track whether we've already fired onSuccess to avoid double-calling
  const didFireSuccess = useRef(false);

  // Resolve `showWallets` into per-chain booleans. Done before any dynamic
  // import hooks so loader hooks are called unconditionally.
  const wantWalletEvm =
    showWallets === true ||
    (typeof showWallets === "object" && !!showWallets?.evm);
  const wantWalletSolana =
    showWallets === true ||
    (typeof showWallets === "object" && !!showWallets?.solana);

  // Provider feature-detect. Backend reports siwe/siws via GET /v1/auth/providers.
  // Default to false until the backend confirms; we don't want to render wallet
  // buttons during initial load (providers === null) or when discovery failed.
  // This mirrors the OAuth gating pattern used elsewhere in this component.
  const providers = ctx?.providers;
  const siweEnabled = wantWalletEvm && providers?.siwe === true;
  const siwsEnabled = wantWalletSolana && providers?.siws === true;

  // Read panel loaders from the wallet registry. The registry is populated
  // as a side effect when the consumer imports `@elizaos/ui`. If they
  // didn't import that subpath, the loaders are undefined and we render no
  // wallet buttons (consistent with optional peer dep contract).
  const evmRegistered = useMemo<WalletPanelLoader | undefined>(
    () => (siweEnabled ? getEvmWalletPanel() : undefined),
    [siweEnabled],
  );
  const solanaRegistered = useMemo<WalletPanelLoader | undefined>(
    () => (siwsEnabled ? getSolanaWalletPanel() : undefined),
    [siwsEnabled],
  );
  const EVMPanel = useDynamicWalletPanel(
    siweEnabled && !!evmRegistered,
    evmRegistered?.load as
      | (() => Promise<{ default: WalletPanelComponent }>)
      | undefined,
  );
  const SolanaPanel = useDynamicWalletPanel(
    siwsEnabled && !!solanaRegistered,
    solanaRegistered?.load as
      | (() => Promise<{ default: WalletPanelComponent }>)
      | undefined,
  );

  // When auth state changes to authenticated, fire onSuccess for redirect
  useEffect(() => {
    if (
      ctx?.isAuthenticated &&
      ctx.session?.token &&
      onSuccess &&
      !didFireSuccess.current
    ) {
      didFireSuccess.current = true;
      const user = ctx.session.user ?? { id: "", email: "" };
      onSuccess({ token: ctx.session.token, user });
    }
  }, [ctx?.isAuthenticated, ctx?.session, onSuccess]);

  // Wallet panel callbacks. Defined before any early return so hook order
  // stays stable across the missing-context branch.
  const handleWalletSuccess = useCallback(
    (
      result: LoginAuthResult | LoginMfaRequiredResult,
      kind: "evm" | "solana",
    ) => {
      setLoadingBtn(null);
      setStep("idle");
      setErrorMsg(null);
      // Mark didFireSuccess BEFORE invoking onSuccess so the auth-state
      // effect (which fires when ctx.isAuthenticated flips) does not
      // double-invoke. The wallet sign helpers already wrote the session
      // into the auth context, so the effect would otherwise see the new
      // authenticated state on its next render and fire again.
      if (!("mfaRequired" in result && result.mfaRequired)) {
        didFireSuccess.current = true;
      }
      composeWalletSuccess(onSuccess)(result, kind);
    },
    [onSuccess],
  );

  const handleWalletError = useCallback(
    (err: Error, kind: "evm" | "solana") => {
      setErrorMsg(err.message || "wallet sign-in failed");
      setStep("error");
      setLoadingBtn(null);
      composeWalletError(onError)(err, kind);
    },
    [onError],
  );

  // Class overrides for the wallet panels so they slot into the card layout
  // and look like siblings of the OAuth buttons.
  const walletClasses = useMemo(
    () => ({
      column: "stwd-login__wallet-col",
      heading: "stwd-login__wallet-heading",
      status: "stwd-login__wallet-status",
      signButton: "stwd-login__btn stwd-login__btn--wallet",
      hint: "stwd-login__wallet-hint",
      error: "stwd-login__error",
    }),
    [],
  );

  if (!ctx) {
    return (
      <div className={`stwd-login stwd-login--error ${className ?? ""}`}>
        <p className="stwd-login__error">
          LoginForm needs a &lt;LoginProvider&gt; with an <code>auth</code>{" "}
          prop.
        </p>
      </div>
    );
  }

  // Determine which OAuth providers to show based on API + props
  const googleEnabled = showGoogle && (providers?.google ?? false);
  const discordEnabled = showDiscord && (providers?.discord ?? false);
  const githubEnabled = showGithub && (providers?.github ?? false);
  const twitterEnabled = showTwitter && (providers?.twitter ?? false);
  const telegramEnabled =
    showTelegram &&
    providers?.telegram === true &&
    typeof getTelegramLoginPayload === "function";
  const farcasterEnabled =
    showFarcaster &&
    providers?.farcaster === true &&
    typeof getFarcasterLoginPayload === "function";
  const hasOAuth =
    googleEnabled ||
    discordEnabled ||
    githubEnabled ||
    twitterEnabled ||
    telegramEnabled ||
    farcasterEnabled;
  const smsEnabled = showSms && providers?.sms === true;
  const whatsappEnabled = showWhatsApp && providers?.whatsapp === true;
  const hasPhoneOtp = smsEnabled || whatsappEnabled;
  // Wallet UI requires both: backend confirms support AND a panel loader is
  // registered (i.e. consumer imported `@elizaos/ui`). Without
  // a registered panel, rendering would show a permanently-disabled
  // loading placeholder, which is worse than hiding the button.
  const evmReady = siweEnabled && !!evmRegistered;
  const solanaReady = siwsEnabled && !!solanaRegistered;
  const hasWallet = evmReady || solanaReady;

  const handleError = (err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    setErrorMsg(error.message);
    setStep("error");
    setLoadingBtn(null);
    onError?.(error);
  };

  const handleGuestSignIn = async () => {
    setStep("loading");
    setLoadingBtn("guest");
    setErrorMsg(null);
    try {
      const result = await ctx.signInAsGuest(
        tenantId ? { tenantId } : undefined,
      );
      if ("token" in result) {
        didFireSuccess.current = true;
        onSuccess?.({ token: result.token, user: result.user });
      } else {
        onSuccess?.(result);
      }
    } catch (err) {
      handleError(err);
    }
  };

  const handleGuestUpgrade = async () => {
    const trimmedEmail = guestUpgradeEmail.trim();
    const trimmedToken = guestUpgradeToken.trim();
    if (!trimmedEmail || !trimmedToken) {
      setErrorMsg("enter the guest email and verification token");
      setStep("error");
      return;
    }
    setStep("loading");
    setLoadingBtn("guest-upgrade");
    setErrorMsg(null);
    try {
      const result = await ctx.upgradeGuestWithEmail({
        email: trimmedEmail,
        token: trimmedToken,
      });
      if ("token" in result) {
        didFireSuccess.current = true;
        onSuccess?.({ token: result.token, user: result.user });
      } else {
        onSuccess?.(result);
      }
      setLoadingBtn(null);
      setStep("idle");
    } catch (err) {
      handleError(err);
    }
  };

  const handleGuestDelete = async () => {
    setStep("loading");
    setLoadingBtn("guest-delete");
    setErrorMsg(null);
    try {
      const result = await ctx.deleteGuest();
      onGuestDeleted?.(result);
      setLoadingBtn(null);
      setStep("idle");
    } catch (err) {
      handleError(err);
    }
  };

  const handlePasskey = async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setErrorMsg("enter your email first");
      setStep("error");
      return;
    }
    setStep("loading");
    setLoadingBtn("passkey");
    setErrorMsg(null);
    try {
      const result = await ctx.signInWithPasskey(trimmedEmail);
      onSuccess?.(result);
    } catch (err) {
      // The user might have an account whose passkey was registered against
      // a different relying party (e.g. they originally signed up on
      // elizacloud.ai and are now trying to sign in on waifu.fun). In that
      // case the WebAuthn handshake fails because the browser refuses to
      // surface a credential bound to another RP — even though their
      // account is real and a magic link would work. Treat recoverable
      // failures as a transparent fall-through to email sign-in and queue
      // a "register passkey here" prompt for the post-login surface.
      if (showEmail && isRecoverablePasskeyFailure(err)) {
        try {
          if (typeof window !== "undefined") {
            window.sessionStorage.setItem(
              PASSKEY_ENROLL_PROMPT_KEY,
              trimmedEmail,
            );
          }
        } catch {
          // sessionStorage unavailable (private mode, sandboxed iframe) — the
          // enrollment prompt simply won’t appear, which is acceptable.
        }
        setStep("passkey-fallback-pending");
        setLoadingBtn("email");
        try {
          await ctx.signInWithEmail(trimmedEmail);
          setStep("email-sent");
          setLoadingBtn(null);
          return;
        } catch (emailErr) {
          handleError(emailErr);
          return;
        }
      }
      handleError(err);
    }
  };

  const handleEmail = async () => {
    if (!email.trim()) {
      setErrorMsg("enter your email");
      setStep("error");
      return;
    }
    setStep("loading");
    setLoadingBtn("email");
    setErrorMsg(null);
    try {
      await ctx.signInWithEmail(email.trim());
      setStep("email-sent");
      setLoadingBtn(null);
    } catch (err) {
      handleError(err);
    }
  };

  const handleSmsSend = async () => {
    const trimmedPhone = phone.trim();
    if (!trimmedPhone) {
      setErrorMsg("enter your phone number");
      setStep("error");
      return;
    }
    setStep("loading");
    setLoadingBtn("sms");
    setErrorMsg(null);
    try {
      await ctx.sendSmsOtp(trimmedPhone);
      setPhoneOtpChannel("sms");
      setSmsStep("sent");
      setStep("idle");
      setLoadingBtn(null);
    } catch (err) {
      handleError(err);
    }
  };

  const handleSmsVerify = async () => {
    const trimmedPhone = phone.trim();
    const trimmedCode = smsCode.trim();
    if (!trimmedPhone || !trimmedCode) {
      setErrorMsg("enter your phone number and code");
      setStep("error");
      return;
    }
    setStep("loading");
    setLoadingBtn(
      phoneOtpChannel === "whatsapp" ? "whatsapp-verify" : "sms-verify",
    );
    setErrorMsg(null);
    try {
      const result =
        phoneOtpChannel === "whatsapp"
          ? await ctx.verifyWhatsAppOtp(trimmedPhone, trimmedCode)
          : await ctx.verifySmsOtp(trimmedPhone, trimmedCode);
      onSuccess?.(result);
    } catch (err) {
      handleError(err);
    }
  };

  const handleWhatsAppSend = async () => {
    const trimmedPhone = phone.trim();
    if (!trimmedPhone) {
      setErrorMsg("enter your phone number");
      setStep("error");
      return;
    }
    setStep("loading");
    setLoadingBtn("whatsapp");
    setErrorMsg(null);
    try {
      await ctx.sendWhatsAppOtp(trimmedPhone);
      setPhoneOtpChannel("whatsapp");
      setSmsStep("sent");
      setStep("idle");
      setLoadingBtn(null);
    } catch (err) {
      handleError(err);
    }
  };

  const handleOAuth = async (
    provider: "google" | "discord" | "github" | "twitter",
  ) => {
    setStep("loading");
    setLoadingBtn(provider);
    setErrorMsg(null);
    try {
      if (typeof ctx.signInWithOAuth !== "function") {
        throw new Error("OAuth unavailable. update @elizaos/login");
      }
      const result = await ctx.signInWithOAuth(
        provider,
        tenantId ? { tenantId } : undefined,
      );
      onSuccess?.(result);
    } catch (err) {
      handleError(err);
    }
  };

  const handleTelegram = async () => {
    if (typeof getTelegramLoginPayload !== "function") {
      handleError(
        new Error("Telegram login payload callback is not configured"),
      );
      return;
    }
    setStep("loading");
    setLoadingBtn("telegram");
    setErrorMsg(null);
    try {
      const payload = await getTelegramLoginPayload();
      const result = await ctx.signInWithTelegram(
        payload,
        tenantId ? { tenantId } : undefined,
      );
      onSuccess?.(result);
    } catch (err) {
      handleError(err);
    }
  };

  const handleFarcaster = async () => {
    if (typeof getFarcasterLoginPayload !== "function") {
      handleError(
        new Error("Farcaster login payload callback is not configured"),
      );
      return;
    }
    setStep("loading");
    setLoadingBtn("farcaster");
    setErrorMsg(null);
    try {
      const payload = await getFarcasterLoginPayload();
      const result = await ctx.signInWithFarcaster(
        payload,
        tenantId ? { tenantId } : undefined,
      );
      onSuccess?.(result);
    } catch (err) {
      handleError(err);
    }
  };

  const isLoading = step === "loading" || ctx.isLoading;
  const variantClass =
    variant === "card" ? "stwd-login--card" : "stwd-login--inline";

  // Full users have already completed auth. Guests keep a small hosted/default
  // lifecycle panel available so they can upgrade or explicitly delete the
  // temporary account without leaving the widget.
  if (ctx.isAuthenticated) {
    if (!showGuest || !ctx.guestState.isGuest) return null;
    return (
      <div
        className={`stwd-login ${variantClass} stwd-login--guest ${className ?? ""}`}
        data-testid="stwd-login-guest-lifecycle"
      >
        <div className="stwd-login__notice">
          <p>{ctx.guestState.expiryMessage ?? "guest session active"}</p>
          {ctx.guestState.isExpired ? (
            <p className="stwd-login__notice-sub">
              upgrade or delete this guest account
            </p>
          ) : (
            <p className="stwd-login__notice-sub">
              upgrade to keep your wallet and data
            </p>
          )}
        </div>

        <div className="stwd-login__fields">
          <Input
            className="stwd-login__input"
            type="email"
            placeholder={guestEmailPlaceholder}
            value={guestUpgradeEmail}
            onChange={(e) => setGuestUpgradeEmail(e.target.value)}
            disabled={isLoading}
            autoComplete="email"
            aria-label="guest upgrade email"
          />
          <Input
            className="stwd-login__input"
            type="text"
            placeholder={guestTokenPlaceholder}
            value={guestUpgradeToken}
            onChange={(e) => setGuestUpgradeToken(e.target.value)}
            disabled={isLoading}
            aria-label="guest upgrade token"
          />
        </div>

        <div className="stwd-login__actions">
          <Button
            className="stwd-login__btn stwd-login__btn--email"
            onClick={() => void handleGuestUpgrade()}
            disabled={isLoading}
            type="button"
            data-testid="stwd-login-guest-upgrade"
          >
            {loadingBtn === "guest-upgrade" ? (
              <span className="stwd-login__spinner" />
            ) : (
              <EmailIcon size={18} />
            )}
            <span>{guestUpgradeLabel}</span>
          </Button>
          <Button
            className="stwd-login__btn stwd-login__btn--back"
            onClick={() => void handleGuestDelete()}
            disabled={isLoading}
            type="button"
            data-testid="stwd-login-guest-delete"
          >
            {loadingBtn === "guest-delete" ? (
              <span className="stwd-login__spinner" />
            ) : null}
            <span>{guestDeleteLabel}</span>
          </Button>
        </div>

        {step === "error" && errorMsg && (
          <p className="stwd-login__error" role="alert">
            {errorMsg}
          </p>
        )}
      </div>
    );
  }

  if (step === "email-sent") {
    const wasFallback =
      typeof window !== "undefined" &&
      window.sessionStorage.getItem(PASSKEY_ENROLL_PROMPT_KEY) === email.trim();
    return (
      <div
        className={`stwd-login ${variantClass} stwd-login--sent ${className ?? ""}`}
      >
        <div className="stwd-login__notice">
          <p>
            link sent to <strong>{email}</strong>
          </p>
          <p className="stwd-login__notice-sub">
            {wasFallback
              ? "no passkey on this site yet. we sent you a link instead, you can add one after signing in."
              : "check your inbox, then tap the link"}
          </p>
        </div>
        <Button
          className="stwd-login__btn stwd-login__btn--back"
          onClick={() => {
            setStep("idle");
            setLoadingBtn(null);
            setPhoneOtpChannel(null);
          }}
          type="button"
        >
          back to login
        </Button>
      </div>
    );
  }

  return (
    <div className={`stwd-login ${variantClass} ${className ?? ""}`}>
      {/* Header */}
      {(logo || title || subtitle || tenantId) && (
        <div className="stwd-login__header">
          {logo && <div className="stwd-login__logo">{logo}</div>}
          {title && <h2 className="stwd-login__title">{title}</h2>}
          {subtitle && <p className="stwd-login__subtitle">{subtitle}</p>}
          {tenantId &&
            ctx.tenants &&
            (() => {
              const tenant = ctx.tenants.find((t) => t.tenantId === tenantId);
              return tenant ? (
                <p className="stwd-login__tenant-name">
                  signing in to {tenant.tenantName}
                </p>
              ) : null;
            })()}
        </div>
      )}

      {/* Email input */}
      {(showPasskey || showEmail) && (
        <div className="stwd-login__fields">
          <Input
            className="stwd-login__input"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (showPasskey) void handlePasskey();
                else if (showEmail) void handleEmail();
              }
            }}
            disabled={isLoading}
            // No "webauthn" autofill token here: it arms browser conditional
            // mediation, which surfaces ANY discoverable passkey for this RP
            // regardless of the email being typed. That hijacked new-account
            // signup (typing a brand-new email prompted an existing account's
            // passkey). Passkey login stays available via the explicit passkey
            // button, which scopes the ceremony to the typed email.
            autoComplete="email"
            aria-label="email"
          />
        </div>
      )}

      {hasPhoneOtp && (
        <div className="stwd-login__fields">
          <Input
            className="stwd-login__input"
            type="tel"
            placeholder="+14155550123"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (smsStep === "sent") void handleSmsVerify();
                else if (smsEnabled) void handleSmsSend();
                else void handleWhatsAppSend();
              }
            }}
            disabled={isLoading}
            autoComplete="tel"
            aria-label="phone"
          />
          {smsStep === "sent" && (
            <Input
              className="stwd-login__input"
              type="text"
              placeholder="000000"
              value={smsCode}
              onChange={(e) => setSmsCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSmsVerify();
              }}
              disabled={isLoading}
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="sms code"
            />
          )}
        </div>
      )}

      {/* Primary auth buttons */}
      <div className="stwd-login__actions">
        {showPasskey && (
          <Button
            className="stwd-login__btn stwd-login__btn--passkey"
            onClick={() => void handlePasskey()}
            disabled={isLoading}
            type="button"
          >
            {loadingBtn === "passkey" ? (
              <span className="stwd-login__spinner" />
            ) : (
              <PasskeyIcon size={18} />
            )}
            <span>passkey</span>
          </Button>
        )}

        {showEmail && (
          <Button
            className="stwd-login__btn stwd-login__btn--email"
            onClick={() => void handleEmail()}
            disabled={isLoading}
            type="button"
          >
            {loadingBtn === "email" ? (
              <span className="stwd-login__spinner" />
            ) : (
              <EmailIcon size={18} />
            )}
            <span>email me a link</span>
          </Button>
        )}

        {smsEnabled && (
          <Button
            className="stwd-login__btn stwd-login__btn--sms"
            onClick={() =>
              void (smsStep === "sent" ? handleSmsVerify() : handleSmsSend())
            }
            disabled={isLoading}
            type="button"
          >
            {loadingBtn === "sms" || loadingBtn === "sms-verify" ? (
              <span className="stwd-login__spinner" />
            ) : (
              <span className="stwd-login__btn-icon">#</span>
            )}
            <span>
              {smsStep === "sent" ? "verify sms code" : "text me a code"}
            </span>
          </Button>
        )}

        {whatsappEnabled && (
          <Button
            className="stwd-login__btn stwd-login__btn--whatsapp"
            onClick={() =>
              void (smsStep === "sent"
                ? handleSmsVerify()
                : handleWhatsAppSend())
            }
            disabled={isLoading}
            type="button"
          >
            {loadingBtn === "whatsapp" || loadingBtn === "whatsapp-verify" ? (
              <span className="stwd-login__spinner" />
            ) : (
              <span className="stwd-login__btn-icon">WA</span>
            )}
            <span>
              {smsStep === "sent" && phoneOtpChannel === "whatsapp"
                ? "verify WhatsApp code"
                : "WhatsApp code"}
            </span>
          </Button>
        )}

        {showGuest && (
          <Button
            className="stwd-login__btn stwd-login__btn--guest"
            onClick={() => void handleGuestSignIn()}
            disabled={isLoading}
            type="button"
            data-testid="stwd-login-guest"
          >
            {loadingBtn === "guest" ? (
              <span className="stwd-login__spinner" />
            ) : null}
            <span>{guestSignInLabel}</span>
          </Button>
        )}
      </div>

      {/* Wallet sign-in. Renders inline panels (Approach A) so consumers reuse
          the existing tested SIWE/SIWS flow. The wagmi / @solana/* peer-dep
          imports stay isolated behind dynamic import. */}
      {hasWallet && (
        <div
          className="stwd-login__wallets stwd-wallet-root"
          data-testid="stwd-login-wallets"
        >
          {evmReady &&
            (EVMPanel ? (
              <EVMPanel
                classes={walletClasses}
                onSuccess={handleWalletSuccess}
                onError={handleWalletError}
                label="ethereum"
                signLabel={(name) =>
                  name ? `sign in with ${name}` : "sign in with EVM wallet"
                }
              />
            ) : (
              <Button
                type="button"
                className="stwd-login__btn stwd-login__btn--wallet"
                disabled
                data-testid="stwd-login-wallet-evm-loading"
              >
                <EthereumIcon size={18} />
                <span>loading EVM wallet...</span>
              </Button>
            ))}
          {solanaReady &&
            (SolanaPanel ? (
              <SolanaPanel
                classes={walletClasses}
                onSuccess={handleWalletSuccess}
                onError={handleWalletError}
                label="solana"
                signLabel={(name) =>
                  name ? `sign in with ${name}` : "sign in with solana wallet"
                }
              />
            ) : (
              <Button
                type="button"
                className="stwd-login__btn stwd-login__btn--wallet"
                disabled
                data-testid="stwd-login-wallet-sol-loading"
              >
                <span>loading solana wallet...</span>
              </Button>
            ))}
        </div>
      )}

      {/* Divider */}
      {hasOAuth &&
        (showPasskey || showEmail || hasPhoneOtp || hasWallet || showGuest) && (
          <div className="stwd-login__divider">
            <span>or</span>
          </div>
        )}

      {/* OAuth buttons. Grid layout when 3+ providers, single column when
          1-2. Each button gets its real provider glyph (no shared icon). */}
      {hasOAuth && (
        <div
          className={
            [
              googleEnabled,
              discordEnabled,
              githubEnabled,
              twitterEnabled,
              telegramEnabled,
              farcasterEnabled,
            ].filter(Boolean).length >= 3
              ? "stwd-login__oauth stwd-login__oauth--grid"
              : "stwd-login__oauth"
          }
        >
          {googleEnabled && (
            <Button
              className="stwd-login__btn stwd-login__btn--google"
              onClick={() => void handleOAuth("google")}
              disabled={isLoading}
              type="button"
            >
              {loadingBtn === "google" ? (
                <span className="stwd-login__spinner stwd-login__spinner--dark" />
              ) : (
                <GoogleIcon size={18} />
              )}
              <span>Google</span>
            </Button>
          )}

          {discordEnabled && (
            <Button
              className="stwd-login__btn stwd-login__btn--discord"
              onClick={() => void handleOAuth("discord")}
              disabled={isLoading}
              type="button"
            >
              {loadingBtn === "discord" ? (
                <span className="stwd-login__spinner" />
              ) : (
                <DiscordIcon size={18} />
              )}
              <span>Discord</span>
            </Button>
          )}

          {githubEnabled && (
            <Button
              className="stwd-login__btn stwd-login__btn--github"
              onClick={() => void handleOAuth("github")}
              disabled={isLoading}
              type="button"
            >
              {loadingBtn === "github" ? (
                <span className="stwd-login__spinner" />
              ) : (
                <GitHubIcon size={18} />
              )}
              <span>GitHub</span>
            </Button>
          )}

          {twitterEnabled && (
            <Button
              className="stwd-login__btn stwd-login__btn--twitter"
              onClick={() => void handleOAuth("twitter")}
              disabled={isLoading}
              type="button"
            >
              {loadingBtn === "twitter" ? (
                <span className="stwd-login__spinner" />
              ) : (
                <XIcon size={16} />
              )}
              <span>X</span>
            </Button>
          )}

          {telegramEnabled && (
            <Button
              className="stwd-login__btn stwd-login__btn--telegram"
              onClick={() => void handleTelegram()}
              disabled={isLoading}
              type="button"
            >
              {loadingBtn === "telegram" ? (
                <span className="stwd-login__spinner" />
              ) : (
                <TelegramIcon size={18} />
              )}
              <span>Telegram</span>
            </Button>
          )}

          {farcasterEnabled && (
            <Button
              className="stwd-login__btn stwd-login__btn--farcaster"
              onClick={() => void handleFarcaster()}
              disabled={isLoading}
              type="button"
            >
              {loadingBtn === "farcaster" ? (
                <span className="stwd-login__spinner" />
              ) : (
                <FarcasterIcon size={18} />
              )}
              <span>Farcaster</span>
            </Button>
          )}
        </div>
      )}

      {/* Legacy SIWE placeholder. Prefer `showWallets` instead. Kept for
          backward compatibility with any consumer that was relying on the
          (disabled) placeholder button. */}
      {showSIWE && !hasWallet && (
        <div className="stwd-login__oauth">
          <Button
            className="stwd-login__btn stwd-login__btn--siwe"
            disabled={true}
            type="button"
            title="connect a wallet to sign in"
          >
            <EthereumIcon size={18} />
            <span>sign in with ethereum</span>
          </Button>
        </div>
      )}

      {/* Error */}
      {step === "error" && errorMsg && (
        <p className="stwd-login__error" role="alert">
          {errorMsg}
        </p>
      )}
    </div>
  );
}
