import { useContext, useEffect, useRef, useState } from "react";
import { DiscordIcon, EmailIcon, EthereumIcon, GoogleIcon, PasskeyIcon } from "../icons/index.js";
import { StewardAuthContext } from "../provider.js";
import type { StewardLoginProps } from "../types.js";

type LoginStep = "idle" | "loading" | "email-sent" | "error";
type LoadingButton = "passkey" | "email" | "google" | "discord" | "siwe" | null;

/**
 * StewardLogin — Drop-in auth widget for Steward-powered apps.
 *
 * Must be used inside a <StewardProvider auth={{ baseUrl: "..." }}>.
 *
 * Supports:
 *   - Passkey (WebAuthn) — browser only
 *   - Email magic link
 *   - SIWE (Sign-In With Ethereum) — requires caller to wire in a wallet
 *   - Google OAuth (popup)
 *   - Discord OAuth (popup)
 *
 * @example
 * <StewardProvider client={client} agentId="..." auth={{ baseUrl: "https://api.steward.fi" }}>
 *   <StewardLogin
 *     variant="card"
 *     title="Welcome back"
 *     showGoogle
 *     showDiscord
 *     onSuccess={({ token }) => console.log("signed in:", token)}
 *   />
 * </StewardProvider>
 */
export function StewardLogin({
  onSuccess,
  onError,
  showPasskey = true,
  showEmail = true,
  showSIWE = false,
  showGoogle = true,
  showDiscord = true,
  variant = "card",
  logo,
  title,
  subtitle,
  tenantId,
  className,
}: StewardLoginProps) {
  const ctx = useContext(StewardAuthContext);

  const [email, setEmail] = useState("");
  const [step, setStep] = useState<LoginStep>("idle");
  const [loadingBtn, setLoadingBtn] = useState<LoadingButton>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Track whether we've already fired onSuccess to avoid double-calling
  const didFireSuccess = useRef(false);

  // When auth state changes to authenticated, fire onSuccess for redirect
  useEffect(() => {
    if (ctx?.isAuthenticated && ctx.session?.token && onSuccess && !didFireSuccess.current) {
      didFireSuccess.current = true;
      const user = ctx.session.user ?? { id: "", email: "" };
      onSuccess({ token: ctx.session.token, user });
    }
  }, [ctx?.isAuthenticated, ctx?.session, onSuccess]);

  if (!ctx) {
    return (
      <div className={`stwd-login stwd-login--error ${className ?? ""}`}>
        <p className="stwd-login__error">
          StewardLogin must be used inside a &lt;StewardProvider&gt; with an <code>auth</code> prop.
        </p>
      </div>
    );
  }

  // Already signed in
  if (ctx.isAuthenticated) {
    return null;
  }

  // Determine which OAuth providers to show based on API + props
  const providers = ctx.providers;
  const googleEnabled = showGoogle && (providers?.google ?? false);
  const discordEnabled = showDiscord && (providers?.discord ?? false);
  const hasOAuth = googleEnabled || discordEnabled;

  const handleError = (err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    setErrorMsg(error.message);
    setStep("error");
    setLoadingBtn(null);
    onError?.(error);
  };

  const handlePasskey = async () => {
    if (!email.trim()) {
      setErrorMsg("Enter your email address first.");
      setStep("error");
      return;
    }
    setStep("loading");
    setLoadingBtn("passkey");
    setErrorMsg(null);
    try {
      // If tenantId provided, pass through via OAuth config pattern
      // The SDK will include it in the request body/headers
      const result = await ctx.signInWithPasskey(email.trim());
      onSuccess?.(result);
    } catch (err) {
      handleError(err);
    }
  };

  const handleEmail = async () => {
    if (!email.trim()) {
      setErrorMsg("Enter your email address.");
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

  const handleOAuth = async (provider: "google" | "discord") => {
    setStep("loading");
    setLoadingBtn(provider);
    setErrorMsg(null);
    try {
      if (typeof ctx.signInWithOAuth !== "function") {
        throw new Error("OAuth not available. Update @stwd/sdk.");
      }
      const result = await ctx.signInWithOAuth(provider, tenantId ? { tenantId } : undefined);
      onSuccess?.(result);
    } catch (err) {
      handleError(err);
    }
  };

  const isLoading = step === "loading" || ctx.isLoading;
  const variantClass = variant === "card" ? "stwd-login--card" : "stwd-login--inline";

  if (step === "email-sent") {
    return (
      <div className={`stwd-login ${variantClass} stwd-login--sent ${className ?? ""}`}>
        <div className="stwd-login__notice">
          <span className="stwd-login__notice-icon">✉️</span>
          <p>
            Magic link sent to <strong>{email}</strong>
          </p>
          <p className="stwd-login__notice-sub">Check your inbox and click the link to sign in.</p>
        </div>
        <button
          className="stwd-login__btn stwd-login__btn--back"
          onClick={() => {
            setStep("idle");
            setLoadingBtn(null);
          }}
          type="button"
        >
          ← Back to login
        </button>
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
                <p className="stwd-login__tenant-name">Signing in to {tenant.tenantName}</p>
              ) : null;
            })()}
        </div>
      )}

      {/* Email input */}
      {(showPasskey || showEmail) && (
        <div className="stwd-login__fields">
          <input
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
            autoComplete="email webauthn"
            aria-label="Email address"
          />
        </div>
      )}

      {/* Primary auth buttons */}
      <div className="stwd-login__actions">
        {showPasskey && (
          <button
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
            <span>Sign in with Passkey</span>
          </button>
        )}

        {showEmail && (
          <button
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
            <span>Send Magic Link</span>
          </button>
        )}
      </div>

      {/* Divider */}
      {hasOAuth && (showPasskey || showEmail) && (
        <div className="stwd-login__divider">
          <span>or</span>
        </div>
      )}

      {/* OAuth buttons */}
      {hasOAuth && (
        <div className="stwd-login__oauth">
          {googleEnabled && (
            <button
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
              <span>Continue with Google</span>
            </button>
          )}

          {discordEnabled && (
            <button
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
              <span>Continue with Discord</span>
            </button>
          )}
        </div>
      )}

      {/* SIWE (placeholder, requires wallet integration) */}
      {showSIWE && (
        <div className="stwd-login__oauth">
          <button
            className="stwd-login__btn stwd-login__btn--siwe"
            disabled={true}
            type="button"
            title="Connect your wallet to sign in with Ethereum"
          >
            <EthereumIcon size={18} />
            <span>Sign in with Ethereum</span>
          </button>
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
