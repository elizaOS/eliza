/**
 * Get Started Page - Unified onboarding flow
 *
 * Users choose their preferred messaging method:
 * - Telegram: OAuth → Phone Input → Success (can use both Telegram + iMessage)
 * - iMessage: Direct - just shows the number with deep link (auto-provisioned on first message)
 * - Discord: OAuth2 → Optional Phone → Setup Guide → Connected
 *
 * Key design decisions:
 * - Telegram requires phone number to prevent bot abuse
 * - Discord phone number is optional (for cross-platform linking with iMessage)
 * - iMessage users don't need to sign up - they're auto-provisioned from carrier-verified phone
 * - Cross-platform: If same phone is used for both, accounts are automatically linked
 */

import { animated, useSpring, useTrail } from "@react-spring/web";
import { ArrowLeft, Check, Copy, ExternalLink, Info } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ElizaLogo } from "@/components/brand/eliza-logo";
import {
  buildFullPhoneNumber,
  PhoneNumberInput,
  useCountryOptions,
} from "@/components/login/phone-number-input";
import ShaderBackground from "@/components/ShaderBackground/ShaderBackground";
import { Button } from "@/components/ui/button";
import {
  buildElizaSmsHref,
  ELIZA_PHONE_FORMATTED,
  ELIZA_PHONE_NUMBER,
  getWhatsAppNumber,
} from "@/lib/contact";
import {
  getAuthToken,
  type TelegramAuthData,
  useAuth,
} from "@/lib/context/auth-context";

type TelegramLoginWindow = Window & {
  Telegram?: {
    Login?: {
      auth: (
        options: { bot_id: string; request_access?: string },
        callback: (data: TelegramAuthData | false) => void,
      ) => void;
    };
  };
};

declare global {
  interface Window {
    Telegram?: TelegramLoginWindow["Telegram"];
  }
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Key used to store the Discord OAuth CSRF state in sessionStorage.
 */
const DISCORD_OAUTH_STATE_KEY = "eliza_discord_oauth_state";

/**
 * Key used to store link mode flag in sessionStorage (persists across OAuth redirect).
 */
const DISCORD_LINK_MODE_KEY = "eliza_discord_link_mode";

/**
 * Generate a cryptographically random string for OAuth2 state parameter (CSRF protection).
 */
function generateOAuthState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================================
// Types
// ============================================================================

type OnboardingMethod = "telegram" | "imessage" | "discord" | "whatsapp";

type OnboardingStep =
  | "SELECT_METHOD"
  | "TELEGRAM_OAUTH"
  | "PHONE_INPUT"
  | "IMESSAGE_DIRECT"
  | "WHATSAPP_DIRECT"
  | "SUCCESS"
  | "DISCORD_CALLBACK"
  | "DISCORD_PHONE_INPUT"
  | "DISCORD_SETUP_GUIDE";

// ============================================================================
// Icons
// ============================================================================

function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <title>Telegram</title>
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <title>Discord</title>
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <title>WhatsApp</title>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}

/**
 * Apple Messages app icon - the classic iOS speech bubble
 */
function AppleMessagesIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 120" fill="none" className={className} aria-hidden>
      <title>Apple Messages</title>
      <defs>
        <linearGradient id="messagesGradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#5FE95C" />
          <stop offset="100%" stopColor="#34C759" />
        </linearGradient>
      </defs>
      <rect width="120" height="120" rx="26" fill="url(#messagesGradient)" />
      <path
        d="M60 28C40.118 28 24 42.326 24 60c0 6.384 2.118 12.322 5.706 17.176L26 92l15.882-4.706C46.588 89.706 53.059 92 60 92c19.882 0 36-14.326 36-32S79.882 28 60 28z"
        fill="white"
      />
    </svg>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function getTelegramBotUsername(): string {
  return import.meta.env.VITE_TELEGRAM_BOT_USERNAME || "ElizaCloudBot";
}

function getTelegramBotId(): string {
  return (import.meta.env.VITE_TELEGRAM_BOT_ID || "").trim();
}

function getDiscordClientId(): string {
  return (import.meta.env.VITE_DISCORD_CLIENT_ID || "").trim();
}

function getDiscordBotApplicationId(): string {
  // Same as client ID for Discord
  return getDiscordClientId();
}

// ============================================================================
// Success Redirect Component - Auto-opens Telegram after auth
// ============================================================================

function SuccessRedirect({
  getTelegramBotUsername,
  handleOpenMessages,
}: {
  getTelegramBotUsername: () => string;
  handleOpenMessages: () => void;
}) {
  const [countdown, setCountdown] = useState(3);
  const [redirected, setRedirected] = useState(false);

  useEffect(() => {
    // Countdown timer
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    // Auto-redirect to Telegram after 3 seconds
    const timeout = setTimeout(() => {
      if (!redirected) {
        setRedirected(true);
        window.location.href = `https://t.me/${getTelegramBotUsername()}`;
      }
    }, 3000);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [getTelegramBotUsername, redirected]);

  const handleOpenTelegramNow = () => {
    if (!redirected) {
      setRedirected(true);
      window.location.href = `https://t.me/${getTelegramBotUsername()}`;
    }
  };

  return (
    <>
      <div className="w-16 h-16 rounded-full bg-[#34C759]/20 flex items-center justify-center mb-6">
        <Check className="size-8 text-[#34C759]" />
      </div>

      <h1 className="text-xl font-medium text-neutral-900 text-center mb-2">
        You&apos;re all set!
      </h1>
      <p className="text-sm text-neutral-500 text-center mb-6">
        Opening Telegram in {countdown}...
      </p>

      {/* Primary action - Open Telegram now */}
      <Button
        type="button"
        onClick={handleOpenTelegramNow}
        className="w-full h-[52px] rounded-xl bg-[#229ED9] hover:bg-[#229ED9]/90 text-white font-medium gap-2 mb-4"
      >
        <TelegramIcon className="size-5" />
        Open Telegram Now
      </Button>

      {/* Secondary option - iMessage */}
      <button
        type="button"
        onClick={handleOpenMessages}
        className="w-full text-sm text-neutral-500 hover:text-neutral-700"
      >
        Or use iMessage instead
      </button>
    </>
  );
}

// ============================================================================
// Inner Component that uses searchParams (needs Suspense boundary)
// ============================================================================

export default function GetStartedPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const {
    isAuthenticated,
    isLoading: authLoading,
    user,
    loginWithTelegram,
    loginWithDiscord,
  } = useAuth();

  // Check for query params (method, Discord OAuth code, guide, link mode)
  const methodParam = searchParams.get("method") as OnboardingMethod | null;
  const discordCode = searchParams.get("code");
  const discordState = searchParams.get("state");
  const guideParam = searchParams.get("guide");
  // link=true means user is adding a platform to their existing account (from /connected page).
  // Also check sessionStorage for persisted link mode (survives Discord OAuth redirect).
  // Fallback heuristic: if the user is already authenticated AND a Discord callback code is
  // present, they must be linking Discord to their existing account — an unauthenticated user
  // wouldn't have a valid session. This guards against sessionStorage losing the key.
  const isLinkMode =
    searchParams.get("link") === "true" ||
    (typeof window !== "undefined" &&
      sessionStorage.getItem(DISCORD_LINK_MODE_KEY) === "true") ||
    (isAuthenticated && !!discordCode);

  // Flow state
  const [step, setStep] = useState<OnboardingStep>("SELECT_METHOD");
  const [, setSelectedMethod] = useState<OnboardingMethod | null>(null);
  const [initialMethodHandled, setInitialMethodHandled] = useState(false);

  // True when we're about to redirect to an external OAuth page (e.g. Discord).
  // Initialized eagerly so we never flash the get-started UI for programmatic redirects.
  const [isRedirectingToOAuth, setIsRedirectingToOAuth] = useState(
    () => methodParam === "discord" && !discordCode,
  );

  // Telegram OAuth state (stored temporarily until phone is collected)
  const [pendingTelegramData, setPendingTelegramData] =
    useState<TelegramAuthData | null>(null);
  const [isTelegramLoading, setIsTelegramLoading] = useState(false);
  const [telegramError, setTelegramError] = useState<string | null>(null);

  // Discord OAuth state
  const [pendingDiscordCode, setPendingDiscordCode] = useState<string | null>(
    null,
  );
  const [pendingDiscordState, setPendingDiscordState] = useState<string | null>(
    null,
  );
  const [discordError, setDiscordError] = useState<string | null>(null);
  const [isDiscordLoading, setIsDiscordLoading] = useState(false);

  // Phone input state (shared for Telegram and Discord flows)
  const [selectedCountry, setSelectedCountry] = useState<string>("US");
  const [phoneValue, setPhoneValue] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [isSubmittingPhone, setIsSubmittingPhone] = useState(false);

  // Flag to suppress auto-redirect to /connected (e.g. when showing Discord setup guide)
  const [suppressRedirect, setSuppressRedirect] = useState(false);

  // Copy state
  const [copied, setCopied] = useState(false);

  // Entrance animation state
  const [showContent, setShowContent] = useState(false);

  // Trigger entrance animation after mount
  useEffect(() => {
    const timer = setTimeout(() => setShowContent(true), 100);
    return () => clearTimeout(timer);
  }, []);

  // Header animation
  const headerSpring = useSpring({
    opacity: showContent ? 1 : 0,
    transform: showContent ? "translateY(0px)" : "translateY(-20px)",
    config: { mass: 1, tension: 280, friction: 24 },
    delay: 200,
  });

  // Title animation
  const titleSpring = useSpring({
    opacity: showContent ? 1 : 0,
    transform: showContent ? "translateY(0px)" : "translateY(30px)",
    config: { mass: 1, tension: 280, friction: 24 },
    delay: 400,
  });

  // Cards staggered animation (trail)
  const cardTrail = useTrail(4, {
    opacity: showContent ? 1 : 0,
    transform: showContent
      ? "translateY(0px) scale(1)"
      : "translateY(40px) scale(0.95)",
    config: { mass: 1, tension: 280, friction: 24 },
    delay: 600,
  });

  // Country options (from shared hook)
  const countryOptions = useCountryOptions();

  const hasPhoneNumber = phoneValue.trim().length > 0;

  /**
   * Redirect to Discord OAuth2 authorization page
   */
  const handleDiscordOAuthRedirect = useCallback(() => {
    const clientId = getDiscordClientId();
    if (!clientId) {
      setDiscordError("Discord not configured");
      return;
    }

    // Generate and store a cryptographic random state for CSRF protection
    const state = generateOAuthState();
    sessionStorage.setItem(DISCORD_OAUTH_STATE_KEY, state);

    // Persist link mode across OAuth redirect (query params are lost during Discord redirect)
    if (isLinkMode) {
      sessionStorage.setItem(DISCORD_LINK_MODE_KEY, "true");
    } else {
      sessionStorage.removeItem(DISCORD_LINK_MODE_KEY);
    }

    const redirectUri = `${window.location.origin}/get-started`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "identify",
      state,
    });

    window.location.href = `https://discord.com/oauth2/authorize?${params.toString()}`;
  }, [isLinkMode]);

  // Redirect if already authenticated (unless suppressed for setup guide, link mode,
  // or an unprocessed Discord callback code is present in the URL).
  useEffect(() => {
    if (
      !authLoading &&
      isAuthenticated &&
      !suppressRedirect &&
      !guideParam &&
      !isLinkMode &&
      !discordCode
    ) {
      navigate("/connected", { replace: true });
    }
  }, [
    isAuthenticated,
    authLoading,
    navigate,
    suppressRedirect,
    guideParam,
    isLinkMode,
    discordCode,
  ]);

  // Handle query params: method shortcut, Discord OAuth callback, or guide revisit
  useEffect(() => {
    if (initialMethodHandled || authLoading) return;

    // Guide revisit: ?guide=discord (user is already authenticated)
    if (guideParam === "discord" && isAuthenticated) {
      setInitialMethodHandled(true);
      setSuppressRedirect(true);
      setSelectedMethod("discord");
      setStep("DISCORD_SETUP_GUIDE");
      return;
    }

    // Don't handle other params if already authenticated (unless in link mode)
    if (isAuthenticated && !isLinkMode) return;

    // Discord OAuth callback: ?code=xxx&state=<random>
    // Validate state parameter against sessionStorage to prevent CSRF attacks
    if (discordCode && discordState) {
      const storedState = sessionStorage.getItem(DISCORD_OAUTH_STATE_KEY);
      if (!storedState || storedState !== discordState) {
        // State mismatch — possible CSRF attack, reject the callback
        setInitialMethodHandled(true);
        setDiscordError(
          "Authentication failed: invalid state. Please try again.",
        );
        setSelectedMethod("discord");
        setStep("SELECT_METHOD");
        return;
      }
      // State is valid — clear from storage to prevent replay, but keep in component state for backend
      sessionStorage.removeItem(DISCORD_OAUTH_STATE_KEY);
      // Note: DISCORD_LINK_MODE_KEY is kept in sessionStorage and read via isLinkMode;
      // it will be cleared when the auth call completes or user navigates away.
      setInitialMethodHandled(true);
      setPendingDiscordCode(discordCode);
      setPendingDiscordState(discordState);
      setSelectedMethod("discord");
      setStep("DISCORD_CALLBACK");
      return;
    }

    // Method shortcut: ?method=telegram or ?method=imessage or ?method=discord
    if (methodParam) {
      setInitialMethodHandled(true);
      if (methodParam === "telegram") {
        setSelectedMethod("telegram");
        setStep("TELEGRAM_OAUTH");
      } else if (methodParam === "imessage") {
        setSelectedMethod("imessage");
        setStep("IMESSAGE_DIRECT");
      } else if (methodParam === "discord") {
        setSelectedMethod("discord");
        handleDiscordOAuthRedirect();
      } else if (methodParam === "whatsapp") {
        setSelectedMethod("whatsapp");
        setStep("WHATSAPP_DIRECT");
      }
    }
  }, [
    methodParam,
    discordCode,
    discordState,
    guideParam,
    initialMethodHandled,
    authLoading,
    isAuthenticated,
    isLinkMode,
    handleDiscordOAuthRedirect,
  ]);

  // Load Telegram widget script on mount
  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.async = true;
    script.setAttribute("data-telegram-login", getTelegramBotUsername());
    script.setAttribute("data-size", "large");
    script.setAttribute("data-request-access", "write");

    const hiddenContainer = document.createElement("div");
    hiddenContainer.style.position = "absolute";
    hiddenContainer.style.visibility = "hidden";
    hiddenContainer.style.width = "0";
    hiddenContainer.style.height = "0";
    hiddenContainer.style.overflow = "hidden";
    hiddenContainer.appendChild(script);
    document.body.appendChild(hiddenContainer);

    return () => {
      hiddenContainer.remove();
    };
  }, []);

  // ============================================================================
  // Handlers
  // ============================================================================

  const getFullPhoneNumber = useCallback(() => {
    return buildFullPhoneNumber(phoneValue, selectedCountry, countryOptions);
  }, [phoneValue, selectedCountry, countryOptions]);

  const handleMethodSelect = (method: OnboardingMethod) => {
    setSelectedMethod(method);
    setPhoneError(null);
    setTelegramError(null);
    setDiscordError(null);

    if (method === "telegram") {
      setStep("TELEGRAM_OAUTH");
    } else if (method === "discord") {
      setIsRedirectingToOAuth(true);
      handleDiscordOAuthRedirect();
    } else if (method === "whatsapp") {
      setStep("WHATSAPP_DIRECT");
    } else {
      // iMessage: Go directly to showing the number (no signup needed)
      setStep("IMESSAGE_DIRECT");
    }
  };

  const handleBack = () => {
    if (step === "TELEGRAM_OAUTH") {
      if (isLinkMode) {
        // In link mode, go back to connected page
        navigate("/connected");
      } else {
        setStep("SELECT_METHOD");
        setSelectedMethod(null);
        setTelegramError(null);
        setPendingTelegramData(null);
      }
    } else if (step === "PHONE_INPUT") {
      setStep("TELEGRAM_OAUTH");
      setPhoneError(null);
    } else if (step === "IMESSAGE_DIRECT" || step === "WHATSAPP_DIRECT") {
      if (isLinkMode) {
        navigate("/connected");
      } else {
        setStep("SELECT_METHOD");
        setSelectedMethod(null);
      }
    } else if (step === "DISCORD_CALLBACK" || step === "DISCORD_PHONE_INPUT") {
      if (isLinkMode) {
        navigate("/connected");
      } else {
        setStep("SELECT_METHOD");
        setSelectedMethod(null);
        setDiscordError(null);
        setPendingDiscordCode(null);
        setPhoneError(null);
      }
    } else if (step === "DISCORD_SETUP_GUIDE") {
      // Can't go back from guide - go to connected
      navigate("/connected");
    } else if (step === "SUCCESS") {
      // Can't go back from success - redirect to connected
      navigate("/connected");
    }
  };

  /**
   * Handle Telegram OAuth callback - stores data and moves to phone input
   */
  const handleTelegramAuthCallback = useCallback(
    (authData: TelegramAuthData) => {
      setPendingTelegramData(authData);
      setTelegramError(null);
      setStep("PHONE_INPUT");
    },
    [],
  );

  /**
   * Trigger Telegram OAuth widget
   */
  const handleTelegramClick = useCallback(() => {
    const botId = getTelegramBotId();
    if (!botId) {
      setTelegramError("Telegram not configured");
      return;
    }

    const telegram = window.Telegram;

    if (telegram?.Login?.auth) {
      setIsTelegramLoading(true);
      telegram.Login.auth(
        { bot_id: botId, request_access: "write" },
        (data) => {
          setIsTelegramLoading(false);
          if (data) {
            handleTelegramAuthCallback(data);
          }
        },
      );
    } else {
      setTelegramError("Telegram widget not loaded. Please refresh the page.");
    }
  }, [handleTelegramAuthCallback]);

  /**
   * Submit Telegram OAuth + phone to backend.
   * If in link mode, passes the existing session token for session-based linking.
   */
  const handlePhoneSubmit = useCallback(async () => {
    if (!pendingTelegramData || !hasPhoneNumber) return;

    const fullPhone = getFullPhoneNumber();
    setIsSubmittingPhone(true);
    setPhoneError(null);

    // In link mode, pass the existing session token for session-based linking
    const existingToken = isLinkMode
      ? (getAuthToken() ?? undefined)
      : undefined;

    const result = await loginWithTelegram(
      pendingTelegramData,
      fullPhone,
      existingToken,
    );

    if (result.success) {
      if (isLinkMode) {
        // In link mode, go back to connected page after linking
        navigate("/connected", { replace: true });
      } else {
        setStep("SUCCESS");
      }
    } else {
      // Handle specific error codes with user-friendly messages
      if (result.errorCode === "PHONE_ALREADY_LINKED") {
        setPhoneError(
          "This phone number is already linked to another account. Please use a different number.",
        );
      } else if (result.errorCode === "PHONE_MISMATCH") {
        setPhoneError(
          "Your Telegram account is already linked to a different phone number.",
        );
      } else if (result.errorCode === "TELEGRAM_ALREADY_LINKED") {
        setTelegramError(
          "This Telegram account is already linked to another user.",
        );
        setStep("SELECT_METHOD");
      } else if (result.errorCode === "INVALID_AUTH") {
        setTelegramError("Telegram authentication expired. Please try again.");
        setStep("SELECT_METHOD");
      } else {
        setPhoneError(
          result.error || "Something went wrong. Please try again.",
        );
      }
    }

    setIsSubmittingPhone(false);
  }, [
    pendingTelegramData,
    hasPhoneNumber,
    getFullPhoneNumber,
    loginWithTelegram,
    isLinkMode,
    navigate,
  ]);

  // ============================================================================
  // Discord Handlers
  // ============================================================================

  /**
   * Process Discord OAuth callback code - submit to backend with optional phone and CSRF state.
   * If in link mode, passes the existing session token for session-based linking.
   */
  const handleDiscordAuthSubmit = useCallback(
    async (phoneNumber?: string) => {
      if (!pendingDiscordCode || !pendingDiscordState) return;

      setIsDiscordLoading(true);
      setDiscordError(null);

      const redirectUri = `${window.location.origin}/get-started`;
      // Suppress redirect so the setup guide can render before navigating away
      setSuppressRedirect(true);

      // In link mode, pass the existing session token for session-based linking
      const existingToken = isLinkMode
        ? (getAuthToken() ?? undefined)
        : undefined;

      const result = await loginWithDiscord(
        pendingDiscordCode,
        redirectUri,
        pendingDiscordState,
        phoneNumber,
        existingToken,
      );

      // Clear persisted link mode flag
      sessionStorage.removeItem(DISCORD_LINK_MODE_KEY);

      if (result.success) {
        if (isLinkMode) {
          // In link mode, go back to connected page after linking
          navigate("/connected", { replace: true });
        } else {
          setStep("DISCORD_SETUP_GUIDE");
        }
      } else {
        setSuppressRedirect(false);
        if (result.errorCode === "PHONE_ALREADY_LINKED") {
          setPhoneError(
            "This phone number is already linked to another account. Please use a different number.",
          );
        } else if (result.errorCode === "DISCORD_ALREADY_LINKED") {
          setDiscordError(
            "This Discord account is already linked to another user. Please use a different Discord account or contact support.",
          );
        } else if (result.errorCode === "INVALID_AUTH") {
          setDiscordError(
            "Discord authentication failed or expired. Please try again.",
          );
        } else {
          setDiscordError(
            result.error || "Something went wrong. Please try again.",
          );
        }
      }

      setIsDiscordLoading(false);
    },
    [
      pendingDiscordCode,
      pendingDiscordState,
      loginWithDiscord,
      isLinkMode,
      navigate,
    ],
  );

  // Auto-skip phone input when linking Discord to an account that already has a phone number.
  // This prevents showing the "Add your phone number" screen to users who already
  // provided their phone during Telegram signup.
  useEffect(() => {
    if (
      step === "DISCORD_CALLBACK" &&
      isLinkMode &&
      user?.phone_number &&
      pendingDiscordCode &&
      pendingDiscordState &&
      !isDiscordLoading
    ) {
      handleDiscordAuthSubmit();
    }
  }, [
    step,
    isLinkMode,
    user?.phone_number,
    pendingDiscordCode,
    pendingDiscordState,
    isDiscordLoading,
    handleDiscordAuthSubmit,
  ]);

  /**
   * Handle Discord phone input submission (optional)
   */
  const handleDiscordPhoneSubmit = useCallback(async () => {
    if (!hasPhoneNumber) return;

    const fullPhone = getFullPhoneNumber();
    setIsSubmittingPhone(true);
    setPhoneError(null);

    await handleDiscordAuthSubmit(fullPhone);

    setIsSubmittingPhone(false);
  }, [hasPhoneNumber, getFullPhoneNumber, handleDiscordAuthSubmit]);

  /**
   * Skip phone and submit Discord auth without phone
   */
  const handleDiscordSkipPhone = useCallback(async () => {
    await handleDiscordAuthSubmit();
  }, [handleDiscordAuthSubmit]);

  /**
   * Copy Eliza's phone number to clipboard
   */
  const handleCopyNumber = async () => {
    await navigator.clipboard.writeText(ELIZA_PHONE_NUMBER);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  /**
   * Open iMessage with pre-populated greeting
   */
  const handleOpenMessages = () => {
    window.location.href = buildElizaSmsHref();
  };

  /**
   * Navigate to dashboard
   */
  const handleContinueToConnected = () => {
    navigate("/connected");
  };

  // ============================================================================
  // Render
  // ============================================================================

  if (authLoading) {
    return (
      <main className="min-h-screen bg-[#0d0d0f] flex flex-col items-center justify-center px-4">
        <div className="text-white/60 animate-pulse">Loading...</div>
      </main>
    );
  }

  if (
    isAuthenticated &&
    !suppressRedirect &&
    !isLinkMode &&
    !guideParam &&
    !discordCode
  ) {
    return (
      <main className="min-h-screen bg-[#0d0d0f] flex flex-col items-center justify-center px-4">
        <div className="text-white/60 animate-pulse">Redirecting...</div>
      </main>
    );
  }

  // Show a minimal loading screen while we redirect to an external OAuth provider
  // (prevents the get-started page from flashing when navigating from /connected)
  if (isRedirectingToOAuth) {
    return (
      <main className="min-h-screen bg-[#0d0d0f] flex flex-col items-center justify-center px-4">
        <div className="text-white/60 animate-pulse">
          Redirecting to Discord...
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex flex-col relative">
      <ShaderBackground />
      <div
        className="fixed inset-0 pointer-events-none mix-blend-overlay z-0"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.7' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
          backgroundRepeat: "repeat",
          backgroundSize: "256px 256px",
        }}
      />
      {/* Header */}
      <animated.header
        className="relative z-10 p-4 flex items-center justify-between"
        style={headerSpring}
      >
        <div className="w-16">
          {step === "DISCORD_SETUP_GUIDE" ? null : step !== "SELECT_METHOD" ? (
            <button
              type="button"
              onClick={handleBack}
              className="inline-flex items-center gap-2 text-neutral-600 hover:text-neutral-900 transition-colors cursor-pointer"
            >
              <ArrowLeft className="size-4" />
              <span className="text-sm">Back</span>
            </button>
          ) : (
            <Link
              to="/"
              className="inline-flex items-center gap-2 text-neutral-600 hover:text-neutral-900 transition-colors"
            >
              <ArrowLeft className="size-4" />
              <span className="text-sm">Home</span>
            </Link>
          )}
        </div>
        <ElizaLogo className="h-8" />
        <div className="w-16" /> {/* Spacer for centering */}
      </animated.header>

      {/* Content */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-4 pb-20">
        <div className="w-full max-w-[400px] flex flex-col items-center">
          {/* ============================================================ */}
          {/* STEP: SELECT_METHOD */}
          {/* ============================================================ */}
          {step === "SELECT_METHOD" && (
            <>
              <animated.div style={titleSpring}>
                <h1 className="text-2xl sm:text-3xl font-bold text-neutral-900 text-center mb-2 whitespace-nowrap">
                  Anywhere you want her to be.
                </h1>
                <p className="text-neutral-600 text-center mb-8">
                  Choose your path(s)
                </p>
              </animated.div>

              {/* Error banner (shown when returning from a failed OAuth or linking attempt) */}
              {(discordError || telegramError) && (
                <div className="w-full mb-4 p-3 rounded-xl bg-red-50 border border-red-200">
                  <p className="text-sm text-red-600 text-center">
                    {discordError || telegramError}
                  </p>
                </div>
              )}

              <div className="w-full flex flex-col gap-3">
                {/* Telegram */}
                <animated.button
                  onClick={() => handleMethodSelect("telegram")}
                  className="w-full h-[72px] bg-white/40 hover:bg-white/60 backdrop-blur-sm rounded-xl border border-white/60 hover:border-white/80 transition-all flex items-center gap-4 px-5 cursor-pointer"
                  style={cardTrail[0]}
                >
                  <div className="w-12 h-12 rounded-xl bg-[#229ED9]/20 flex items-center justify-center shrink-0">
                    <TelegramIcon className="size-6 text-[#229ED9]" />
                  </div>
                  <div className="flex-1 text-left">
                    <p className="text-neutral-900 font-medium">Telegram</p>
                    <p className="text-sm text-neutral-500">
                      Use the Telegram app
                    </p>
                  </div>
                </animated.button>

                {/* iMessage */}
                <animated.button
                  onClick={() => handleMethodSelect("imessage")}
                  className="w-full h-[72px] bg-white/40 hover:bg-white/60 backdrop-blur-sm rounded-xl border border-white/60 hover:border-white/80 transition-all flex items-center gap-4 px-5 cursor-pointer"
                  style={cardTrail[1]}
                >
                  <div className="w-12 h-12 shrink-0 flex items-center justify-center">
                    <AppleMessagesIcon className="size-12" />
                  </div>
                  <div className="flex-1 text-left">
                    <p className="text-neutral-900 font-medium">iMessage</p>
                    <p className="text-sm text-neutral-500">
                      Use text messages
                    </p>
                  </div>
                </animated.button>

                {/* WhatsApp */}
                <animated.button
                  onClick={() => handleMethodSelect("whatsapp")}
                  className="w-full h-[72px] bg-white/40 hover:bg-white/60 backdrop-blur-sm rounded-xl border border-white/60 hover:border-white/80 transition-all flex items-center gap-4 px-5 cursor-pointer"
                  style={cardTrail[2]}
                >
                  <div className="w-12 h-12 rounded-xl bg-[#25D366]/20 flex items-center justify-center shrink-0">
                    <WhatsAppIcon className="size-6 text-[#25D366]" />
                  </div>
                  <div className="flex-1 text-left">
                    <p className="text-neutral-900 font-medium">WhatsApp</p>
                    <p className="text-sm text-neutral-500">
                      Use the WhatsApp app
                    </p>
                  </div>
                </animated.button>

                {/* Discord */}
                <animated.button
                  onClick={() => handleMethodSelect("discord")}
                  className="w-full h-[72px] bg-white/40 hover:bg-white/60 backdrop-blur-sm rounded-xl border border-white/60 hover:border-white/80 transition-all flex items-center gap-4 px-5 cursor-pointer"
                  style={cardTrail[3]}
                >
                  <div className="w-12 h-12 rounded-xl bg-[#5865F2]/20 flex items-center justify-center shrink-0">
                    <DiscordIcon className="size-6 text-[#5865F2]" />
                  </div>
                  <div className="flex-1 text-left">
                    <p className="text-neutral-900 font-medium">Discord</p>
                    <p className="text-sm text-neutral-500">
                      Use the Discord app
                    </p>
                  </div>
                </animated.button>
              </div>
            </>
          )}

          {/* ============================================================ */}
          {/* STEP: TELEGRAM_OAUTH */}
          {/* ============================================================ */}
          {step === "TELEGRAM_OAUTH" && (
            <>
              <div className="w-16 h-16 rounded-full bg-[#229ED9]/20 flex items-center justify-center mb-6">
                <TelegramIcon className="size-8 text-[#229ED9]" />
              </div>

              <h1 className="text-xl font-medium text-neutral-900 text-center mb-2">
                Connect with Telegram
              </h1>
              <p className="text-sm text-neutral-500 text-center mb-8">
                Sign in with your Telegram account to get started
              </p>

              {telegramError && (
                <p className="text-sm text-red-500 text-center mb-4">
                  {telegramError}
                </p>
              )}

              <Button
                onClick={handleTelegramClick}
                disabled={isTelegramLoading}
                className="w-full h-[52px] rounded-xl bg-[#229ED9] hover:bg-[#229ED9]/90 text-white font-medium gap-2"
              >
                {isTelegramLoading ? (
                  "Connecting..."
                ) : (
                  <>
                    <TelegramIcon className="size-5" />
                    Connect Telegram
                  </>
                )}
              </Button>
            </>
          )}

          {/* ============================================================ */}
          {/* STEP: PHONE_INPUT (after Telegram OAuth) */}
          {/* ============================================================ */}
          {step === "PHONE_INPUT" && (
            <>
              <div className="w-12 h-12 rounded-xl bg-[#229ED9]/20 flex items-center justify-center mb-6">
                <TelegramIcon className="size-6 text-[#229ED9]" />
              </div>

              <h1 className="text-xl font-medium text-neutral-900 text-center mb-2">
                Almost there!
              </h1>
              <p className="text-sm text-neutral-500 text-center mb-8">
                Enter your phone number to enable iMessage and prevent bots
              </p>

              <div className="w-full mb-4">
                <PhoneNumberInput
                  selectedCountry={selectedCountry}
                  onCountryChange={setSelectedCountry}
                  phoneValue={phoneValue}
                  onPhoneChange={setPhoneValue}
                  onSubmit={handlePhoneSubmit}
                  variant="light"
                  autoFocus
                  countryOptions={countryOptions}
                />
              </div>

              {phoneError && (
                <p className="text-sm text-red-500 text-center mb-4">
                  {phoneError}
                </p>
              )}

              <Button
                onClick={handlePhoneSubmit}
                disabled={!hasPhoneNumber || isSubmittingPhone}
                className={`w-full h-[52px] rounded-xl font-medium transition-colors ${
                  hasPhoneNumber
                    ? "bg-neutral-900 text-white hover:bg-neutral-800"
                    : "bg-neutral-300 text-neutral-500 cursor-not-allowed"
                }`}
              >
                {isSubmittingPhone ? "Setting up..." : "Complete Setup"}
              </Button>

              <p className="text-xs text-neutral-400 text-center mt-4">
                Your phone enables cross-platform chat via iMessage
              </p>
            </>
          )}

          {/* ============================================================ */}
          {/* STEP: IMESSAGE_DIRECT (no signup needed) */}
          {/* ============================================================ */}
          {step === "IMESSAGE_DIRECT" && (
            <>
              <div className="w-16 h-16 flex items-center justify-center mb-6">
                <AppleMessagesIcon className="size-16" />
              </div>

              <h1 className="text-xl font-medium text-neutral-900 text-center mb-2">
                Ready to chat!
              </h1>
              <p className="text-sm text-neutral-500 text-center mb-6">
                Just text this number to start talking with Eliza
              </p>

              {/* Phone number display */}
              <div className="w-full p-4 bg-white/50 backdrop-blur-sm border border-white/60 rounded-xl mb-6">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-lg font-mono text-neutral-900">
                    {ELIZA_PHONE_FORMATTED}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCopyNumber}
                    className="shrink-0 text-neutral-500 hover:text-neutral-900 hover:bg-neutral-200/50"
                  >
                    {copied ? (
                      <Check className="size-4 text-green-500" />
                    ) : (
                      <Copy className="size-4" />
                    )}
                  </Button>
                </div>
              </div>

              {/* Open iMessage with pre-populated message */}
              <Button
                onClick={handleOpenMessages}
                className="w-full h-[52px] rounded-xl bg-[#34C759] hover:bg-[#2DB84D] text-white font-medium gap-2"
              >
                <AppleMessagesIcon className="size-5" />
                Open iMessage
              </Button>

              {/* Option to also connect Telegram */}
              <button
                type="button"
                onClick={() => {
                  setSelectedMethod("telegram");
                  setStep("TELEGRAM_OAUTH");
                }}
                className="w-full mt-4 text-sm text-neutral-500 hover:text-neutral-700"
              >
                I also want to use Telegram
              </button>

              <p className="text-xs text-neutral-400 text-center mt-6">
                No signup required - just send a message!
              </p>
            </>
          )}

          {/* ============================================================ */}
          {/* STEP: WHATSAPP_DIRECT (no signup needed) */}
          {/* ============================================================ */}
          {step === "WHATSAPP_DIRECT" && (
            <>
              <div className="w-16 h-16 rounded-full bg-[#25D366]/20 flex items-center justify-center mb-6">
                <WhatsAppIcon className="size-8 text-[#25D366]" />
              </div>

              <h1 className="text-xl font-medium text-neutral-900 text-center mb-2">
                Chat on WhatsApp!
              </h1>
              <p className="text-sm text-neutral-500 text-center mb-6">
                Message our WhatsApp number to start talking with Eliza
              </p>

              {/* WhatsApp link */}
              <Button
                onClick={() => {
                  const waNumber = getWhatsAppNumber().replace(/\D/g, "");
                  window.open(`https://wa.me/${waNumber}`, "_blank");
                }}
                className="w-full h-[52px] rounded-xl bg-[#25D366] hover:bg-[#25D366]/90 text-white font-medium gap-2"
              >
                <WhatsAppIcon className="size-5" />
                Open WhatsApp
                <ExternalLink className="size-4 ml-1" />
              </Button>

              {/* Option to use other platforms */}
              <button
                type="button"
                onClick={() => {
                  setSelectedMethod("telegram");
                  setStep("TELEGRAM_OAUTH");
                }}
                className="w-full mt-4 text-sm text-neutral-500 hover:text-neutral-700"
              >
                I also want to use Telegram
              </button>

              <p className="text-xs text-neutral-400 text-center mt-6">
                No signup required - just send a message!
              </p>
            </>
          )}

          {/* ============================================================ */}
          {/* STEP: SUCCESS (after Telegram + phone signup) */}
          {/* Auto-redirects to Telegram after 2 seconds */}
          {/* ============================================================ */}
          {step === "SUCCESS" && (
            <SuccessRedirect
              getTelegramBotUsername={getTelegramBotUsername}
              handleOpenMessages={handleOpenMessages}
            />
          )}

          {/* ============================================================ */}
          {/* STEP: DISCORD_CALLBACK (processing OAuth return) */}
          {/* ============================================================ */}
          {step === "DISCORD_CALLBACK" && (
            <>
              <div
                className={`w-16 h-16 rounded-full ${discordError ? "bg-red-100" : "bg-[#5865F2]/20"} flex items-center justify-center mb-6`}
              >
                <DiscordIcon
                  className={`size-8 ${discordError ? "text-red-500" : "text-[#5865F2]"}`}
                />
              </div>

              <h1 className="text-xl font-medium text-neutral-900 text-center mb-2">
                {discordError
                  ? "Connection Failed"
                  : isLinkMode && user?.phone_number
                    ? "Connecting Discord..."
                    : "Discord Connected"}
              </h1>
              <p className="text-sm text-neutral-500 text-center mb-8">
                {discordError
                  ? "There was a problem connecting your Discord account"
                  : isLinkMode && user?.phone_number
                    ? "Linking your Discord account..."
                    : "Add your phone number to link iMessage, or skip this step"}
              </p>

              {discordError && (
                <div className="w-full mb-4 p-3 rounded-xl bg-red-50 border border-red-200">
                  <p className="text-sm text-red-600 text-center">
                    {discordError}
                  </p>
                </div>
              )}

              {discordError ? (
                /* Discord-level error: show retry / go back instead of phone form */
                <>
                  <Button
                    onClick={() => handleMethodSelect("discord")}
                    className="w-full h-[52px] rounded-xl bg-[#5865F2] text-white font-medium hover:bg-[#5865F2]/90"
                  >
                    Try Again
                  </Button>
                  <button
                    type="button"
                    onClick={handleBack}
                    className="w-full mt-4 text-sm text-neutral-500 hover:text-neutral-700 cursor-pointer"
                  >
                    Choose a different method
                  </button>
                </>
              ) : isLinkMode && user?.phone_number ? (
                /* Link mode with existing phone: auto-submitting, show spinner */
                <div className="w-full flex flex-col items-center gap-3">
                  <div className="text-neutral-500 animate-pulse text-sm">
                    Setting up...
                  </div>
                </div>
              ) : (
                /* No discord error, no existing phone: show phone input form */
                <>
                  <div className="w-full mb-4">
                    <PhoneNumberInput
                      selectedCountry={selectedCountry}
                      onCountryChange={setSelectedCountry}
                      phoneValue={phoneValue}
                      onPhoneChange={setPhoneValue}
                      onSubmit={handleDiscordPhoneSubmit}
                      variant="light"
                      autoFocus
                      countryOptions={countryOptions}
                    />
                  </div>

                  {phoneError && (
                    <p className="text-sm text-red-500 text-center mb-4">
                      {phoneError}
                    </p>
                  )}

                  <Button
                    onClick={handleDiscordPhoneSubmit}
                    disabled={
                      !hasPhoneNumber || isSubmittingPhone || isDiscordLoading
                    }
                    className={`w-full h-[52px] rounded-xl font-medium transition-colors ${
                      hasPhoneNumber
                        ? "bg-[#5865F2] text-white hover:bg-[#5865F2]/90"
                        : "bg-neutral-300 text-neutral-500 cursor-not-allowed"
                    }`}
                  >
                    {isSubmittingPhone || isDiscordLoading
                      ? "Setting up..."
                      : "Continue with Phone"}
                  </Button>

                  <button
                    type="button"
                    onClick={handleDiscordSkipPhone}
                    disabled={isDiscordLoading}
                    className="w-full mt-4 text-sm text-neutral-500 hover:text-neutral-700 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                  >
                    {isDiscordLoading
                      ? "Setting up..."
                      : "Skip — I\u2019ll add it later"}
                  </button>

                  <p className="text-xs text-neutral-400 text-center mt-4">
                    Phone number enables cross-platform chat via iMessage
                  </p>
                </>
              )}
            </>
          )}

          {/* ============================================================ */}
          {/* STEP: DISCORD_SETUP_GUIDE (after auth success) */}
          {/* ============================================================ */}
          {step === "DISCORD_SETUP_GUIDE" && (
            <>
              {guideParam ? (
                <>
                  <div className="w-16 h-16 rounded-full bg-[#5865F2]/20 flex items-center justify-center mb-6">
                    <Info className="size-8 text-[#5865F2]" />
                  </div>
                  <h1 className="text-xl font-medium text-neutral-900 text-center mb-2">
                    Discord Setup Guide
                  </h1>
                </>
              ) : (
                <>
                  <div className="w-16 h-16 rounded-full bg-[#5865F2]/20 flex items-center justify-center mb-6">
                    <Check className="size-8 text-[#5865F2]" />
                  </div>
                  <h1 className="text-xl font-medium text-neutral-900 text-center mb-2">
                    You&apos;re all set!
                  </h1>
                </>
              )}
              <p className="text-sm text-neutral-500 text-center mb-8">
                Here&apos;s how to start chatting with Eliza on Discord
              </p>

              <div className="w-full flex flex-col gap-4">
                {/* Step 1: Add bot to server (optional) */}
                <div className="w-full p-4 bg-white/50 backdrop-blur-sm border border-white/60 rounded-xl">
                  <div className="flex items-start gap-3">
                    <div className="w-7 h-7 rounded-full bg-[#5865F2]/20 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-xs font-bold text-[#5865F2]">
                        1
                      </span>
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-neutral-900">
                        Add Eliza to your server
                      </p>
                      <p className="text-xs text-neutral-500 mt-1">
                        Already have Eliza in a server? Skip this step.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const clientId = getDiscordClientId();
                          window.open(
                            `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=2048&scope=bot`,
                            "_blank",
                          );
                        }}
                        className="mt-3 text-[#5865F2] border-[#5865F2]/30 hover:bg-[#5865F2]/10 gap-1.5"
                      >
                        <ExternalLink className="size-3.5" />
                        Invite to Server
                      </Button>
                      <p className="text-[11px] text-neutral-400 mt-2">
                        Only needed if Eliza isn&apos;t in a server you&apos;re
                        part of
                      </p>
                    </div>
                  </div>
                </div>

                {/* Step 2: Open DM */}
                <div className="w-full p-4 bg-white/50 backdrop-blur-sm border border-white/60 rounded-xl">
                  <div className="flex items-start gap-3">
                    <div className="w-7 h-7 rounded-full bg-[#5865F2]/20 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-xs font-bold text-[#5865F2]">
                        2
                      </span>
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-neutral-900">
                        Send a direct message
                      </p>
                      <p className="text-xs text-neutral-500 mt-1">
                        Open Discord and start a DM with Eliza
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const appId = getDiscordBotApplicationId();
                          window.open(
                            `https://discord.com/users/${appId}`,
                            "_blank",
                          );
                        }}
                        className="mt-3 text-[#5865F2] border-[#5865F2]/30 hover:bg-[#5865F2]/10 gap-1.5"
                      >
                        <ExternalLink className="size-3.5" />
                        Open DM
                      </Button>
                      <p className="text-[11px] text-neutral-400 mt-2">
                        You can also right-click the bot in any shared server
                        and select &quot;Message&quot;
                      </p>
                    </div>
                  </div>
                </div>

                {/* Step 3: Say hello */}
                <div className="w-full p-4 bg-white/50 backdrop-blur-sm border border-white/60 rounded-xl">
                  <div className="flex items-start gap-3">
                    <div className="w-7 h-7 rounded-full bg-[#5865F2]/20 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-xs font-bold text-[#5865F2]">
                        3
                      </span>
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-neutral-900">
                        Start chatting
                      </p>
                      <p className="text-xs text-neutral-500 mt-1">
                        Try sending your first message:
                      </p>
                      <div className="mt-2 px-3 py-2 bg-[#5865F2]/10 border border-[#5865F2]/20 rounded-lg">
                        <p className="text-sm text-[#5865F2] font-medium">
                          &quot;Hey Eliza, what can you do?&quot;
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Continue button */}
              <Button
                onClick={handleContinueToConnected}
                className="w-full h-[52px] rounded-xl bg-[#5865F2] hover:bg-[#5865F2]/90 text-white font-medium mt-6"
              >
                Continue
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Footer */}
      <footer className="relative z-10 p-4 text-center">
        <p className="text-[10px] text-neutral-400">
          ElizaCloud Inc. {new Date().getFullYear()}
        </p>
      </footer>
    </main>
  );
}
