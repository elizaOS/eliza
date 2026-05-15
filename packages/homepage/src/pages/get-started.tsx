import { animated, useSpring, useTrail } from "@react-spring/web";
import { ArrowLeft, Check, Copy, ExternalLink, Info, Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ElizaLogo } from "@/components/brand/eliza-logo";
import {
  AppleMessagesIcon,
  DiscordIcon,
  TelegramIcon,
  WhatsAppIcon,
} from "@/components/icons/platform-icons";
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
import { useElizaAppProvisioningChat } from "@/lib/hooks/use-eliza-app-provisioning-chat";

type TelegramLoginApi = {
  Login?: {
    auth: (
      options: { bot_id: string; request_access?: string },
      callback: (data: TelegramAuthData | false) => void,
    ) => void;
  };
};

declare global {
  interface Window {
    Telegram?: TelegramLoginApi;
  }
}

const DISCORD_OAUTH_STATE_KEY = "eliza_discord_oauth_state";
const DISCORD_LINK_MODE_KEY = "eliza_discord_link_mode";

function generateOAuthState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

type OnboardingMethod = "telegram" | "imessage" | "discord" | "whatsapp";

type OnboardingStep =
  | "SELECT_METHOD"
  | "TELEGRAM_OAUTH"
  | "PHONE_INPUT"
  | "IMESSAGE_DIRECT"
  | "WHATSAPP_DIRECT"
  | "DISCORD_CALLBACK"
  | "DISCORD_SETUP_GUIDE"
  | "PROVISIONING_CHAT";

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
  return getDiscordClientId();
}

const MONO = "'Courier New', 'Courier', 'Monaco', monospace";

function ProvisioningChatStep({ onContinue }: { onContinue: () => void }) {
  const { messages, sendMessage, containerStatus, isLoading, isReady } =
    useElizaAppProvisioningChat(true);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  });

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;
    setInput("");
    await sendMessage(text);
    inputRef.current?.focus();
  }, [input, isLoading, sendMessage]);

  const statusLabel = isReady
    ? "Ready! Connecting..."
    : containerStatus === "error"
      ? "Setup failed — please refresh."
      : "Setting up your AI space...";

  const statusColor = isReady
    ? "#4ade80"
    : containerStatus === "error"
      ? "#f87171"
      : "#229ED9";

  return (
    <div style={{ width: "100%", maxWidth: "420px", fontFamily: MONO }}>
      <div className="flex items-center gap-2 mb-4">
        <span
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: "50%",
            backgroundColor: statusColor,
            animation: isReady ? "none" : "gs-pulse 2s ease-in-out infinite",
            flexShrink: 0,
          }}
        />
        <span className="text-xs text-neutral-500 uppercase tracking-widest">
          {statusLabel}
        </span>
        {!isReady && (
          <button
            type="button"
            onClick={onContinue}
            className="ml-auto text-xs text-neutral-400 hover:text-neutral-600 underline underline-offset-2"
          >
            Skip to dashboard
          </button>
        )}
      </div>

      <style>{`
        @keyframes gs-pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
      `}</style>

      <div
        style={{
          height: "min(360px, 55vh)",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: 12,
          background: "rgba(255,255,255,0.38)",
          backdropFilter: "blur(8px)",
          border: "1.5px solid rgba(255,255,255,0.55)",
          borderRadius: 12,
          marginBottom: 10,
        }}
      >
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              display: "flex",
              justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
            }}
          >
            <div
              style={{
                maxWidth: "80%",
                padding: "8px 12px",
                borderRadius:
                  msg.role === "user"
                    ? "14px 14px 4px 14px"
                    : "14px 14px 14px 4px",
                background:
                  msg.role === "user" ? "#1a1a1a" : "rgba(255,255,255,0.72)",
                border:
                  msg.role === "user" ? "none" : "1px solid rgba(0,0,0,0.08)",
                fontSize: 13,
                lineHeight: 1.5,
                color: msg.role === "user" ? "#ffffff" : "#1a1a1a",
              }}
            >
              {msg.content}
            </div>
          </div>
        ))}
        {isLoading && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div
              style={{
                padding: "8px 14px",
                borderRadius: "14px 14px 14px 4px",
                background: "rgba(255,255,255,0.72)",
                fontSize: 12,
                color: "#999",
                letterSpacing: "0.1em",
              }}
            >
              ...
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          ref={inputRef}
          type="text"
          placeholder={isReady ? "Ready!" : "Ask me anything..."}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          disabled={isLoading}
          style={{
            flex: 1,
            height: 44,
            padding: "0 14px",
            borderRadius: 10,
            border: "1.5px solid rgba(0,0,0,0.15)",
            background: "rgba(255,255,255,0.6)",
            backdropFilter: "blur(8px)",
            fontSize: 14,
            fontFamily: MONO,
            outline: "none",
          }}
        />
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={isLoading || !input.trim()}
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            border: "none",
            background:
              isLoading || !input.trim() ? "rgba(0,0,0,0.15)" : "#1a1a1a",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: isLoading || !input.trim() ? "not-allowed" : "pointer",
            transition: "background 0.15s",
          }}
        >
          <Send size={16} />
        </button>
      </div>

      {isReady && (
        <Button
          onClick={onContinue}
          className="w-full h-[52px] rounded-xl bg-neutral-900 text-white font-medium hover:bg-neutral-800 mt-4"
        >
          <Check className="size-4 mr-2" />
          Continue to dashboard
        </Button>
      )}
    </div>
  );
}

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

  const methodParam = searchParams.get("method") as OnboardingMethod | null;
  const discordCode = searchParams.get("code");
  const discordState = searchParams.get("state");
  const guideParam = searchParams.get("guide");
  const isLinkMode =
    searchParams.get("link") === "true" ||
    (typeof window !== "undefined" &&
      sessionStorage.getItem(DISCORD_LINK_MODE_KEY) === "true") ||
    (isAuthenticated && !!discordCode);

  const [step, setStep] = useState<OnboardingStep>("SELECT_METHOD");
  const [, setSelectedMethod] = useState<OnboardingMethod | null>(null);
  const [initialMethodHandled, setInitialMethodHandled] = useState(false);

  const [isRedirectingToOAuth, setIsRedirectingToOAuth] = useState(
    () => methodParam === "discord" && !discordCode,
  );

  const [pendingTelegramData, setPendingTelegramData] =
    useState<TelegramAuthData | null>(null);
  const [isTelegramLoading, setIsTelegramLoading] = useState(false);
  const [telegramError, setTelegramError] = useState<string | null>(null);

  const [pendingDiscordCode, setPendingDiscordCode] = useState<string | null>(
    null,
  );
  const [pendingDiscordState, setPendingDiscordState] = useState<string | null>(
    null,
  );
  const [discordError, setDiscordError] = useState<string | null>(null);
  const [isDiscordLoading, setIsDiscordLoading] = useState(false);

  const [selectedCountry, setSelectedCountry] = useState<string>("US");
  const [phoneValue, setPhoneValue] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [isSubmittingPhone, setIsSubmittingPhone] = useState(false);

  const [suppressRedirect, setSuppressRedirect] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showContent, setShowContent] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShowContent(true), 100);
    return () => clearTimeout(timer);
  }, []);

  const headerSpring = useSpring({
    opacity: showContent ? 1 : 0,
    transform: showContent ? "translateY(0px)" : "translateY(-20px)",
    config: { mass: 1, tension: 280, friction: 24 },
    delay: 200,
  });

  const titleSpring = useSpring({
    opacity: showContent ? 1 : 0,
    transform: showContent ? "translateY(0px)" : "translateY(30px)",
    config: { mass: 1, tension: 280, friction: 24 },
    delay: 400,
  });

  const cardTrail = useTrail(4, {
    opacity: showContent ? 1 : 0,
    transform: showContent
      ? "translateY(0px) scale(1)"
      : "translateY(40px) scale(0.95)",
    config: { mass: 1, tension: 280, friction: 24 },
    delay: 600,
  });

  const countryOptions = useCountryOptions();

  const hasPhoneNumber = phoneValue.trim().length > 0;

  const handleDiscordOAuthRedirect = useCallback((): boolean => {
    const clientId = getDiscordClientId();
    if (!clientId) {
      setDiscordError("Discord not configured");
      setIsRedirectingToOAuth(false);
      setStep("SELECT_METHOD");
      return false;
    }

    const state = generateOAuthState();
    sessionStorage.setItem(DISCORD_OAUTH_STATE_KEY, state);

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
    return true;
  }, [isLinkMode]);

  useEffect(() => {
    if (
      !authLoading &&
      isAuthenticated &&
      !suppressRedirect &&
      !guideParam &&
      !isLinkMode &&
      !discordCode &&
      step !== "PROVISIONING_CHAT"
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
    step,
  ]);

  useEffect(() => {
    if (initialMethodHandled || authLoading) return;

    if (guideParam === "discord" && isAuthenticated) {
      setInitialMethodHandled(true);
      setSuppressRedirect(true);
      setSelectedMethod("discord");
      setStep("DISCORD_SETUP_GUIDE");
      return;
    }

    if (isAuthenticated && !isLinkMode) return;

    if (discordCode && discordState) {
      const storedState = sessionStorage.getItem(DISCORD_OAUTH_STATE_KEY);
      if (!storedState || storedState !== discordState) {
        setInitialMethodHandled(true);
        setDiscordError(
          "Authentication failed: invalid state. Please try again.",
        );
        setSelectedMethod("discord");
        setStep("SELECT_METHOD");
        return;
      }
      sessionStorage.removeItem(DISCORD_OAUTH_STATE_KEY);
      setInitialMethodHandled(true);
      setPendingDiscordCode(discordCode);
      setPendingDiscordState(discordState);
      setSelectedMethod("discord");
      setStep("DISCORD_CALLBACK");
      return;
    }

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
      if (!handleDiscordOAuthRedirect()) {
        setSelectedMethod(null);
      }
    } else if (method === "whatsapp") {
      setStep("WHATSAPP_DIRECT");
    } else {
      setStep("IMESSAGE_DIRECT");
    }
  };

  const handleBack = () => {
    if (step === "TELEGRAM_OAUTH") {
      if (isLinkMode) {
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
    } else if (step === "DISCORD_CALLBACK") {
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
      navigate("/connected");
    }
  };

  const handleTelegramAuthCallback = useCallback(
    (authData: TelegramAuthData) => {
      setPendingTelegramData(authData);
      setTelegramError(null);
      setStep("PHONE_INPUT");
    },
    [],
  );

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
        (data: TelegramAuthData | false) => {
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

  const handlePhoneSubmit = useCallback(async () => {
    if (!pendingTelegramData || !hasPhoneNumber) return;

    const fullPhone = getFullPhoneNumber();
    setIsSubmittingPhone(true);
    setPhoneError(null);

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
        navigate("/connected", { replace: true });
      } else {
        setStep("PROVISIONING_CHAT");
      }
    } else {
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

  const handleDiscordAuthSubmit = useCallback(
    async (phoneNumber?: string) => {
      if (!pendingDiscordCode || !pendingDiscordState) return;

      setIsDiscordLoading(true);
      setDiscordError(null);

      const redirectUri = `${window.location.origin}/get-started`;
      setSuppressRedirect(true);

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

      sessionStorage.removeItem(DISCORD_LINK_MODE_KEY);

      if (result.success) {
        if (isLinkMode) {
          navigate("/connected", { replace: true });
        } else {
          setStep("PROVISIONING_CHAT");
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

  const handleDiscordPhoneSubmit = useCallback(async () => {
    if (!hasPhoneNumber) return;

    const fullPhone = getFullPhoneNumber();
    setIsSubmittingPhone(true);
    setPhoneError(null);

    await handleDiscordAuthSubmit(fullPhone);

    setIsSubmittingPhone(false);
  }, [hasPhoneNumber, getFullPhoneNumber, handleDiscordAuthSubmit]);

  const handleDiscordSkipPhone = useCallback(async () => {
    await handleDiscordAuthSubmit();
  }, [handleDiscordAuthSubmit]);

  const handleCopyNumber = async () => {
    await navigator.clipboard.writeText(ELIZA_PHONE_NUMBER);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleOpenMessages = () => {
    window.location.href = buildElizaSmsHref();
  };

  const handleContinueToConnected = () => {
    navigate("/connected");
  };

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
    !discordCode &&
    step !== "PROVISIONING_CHAT"
  ) {
    return (
      <main className="min-h-screen bg-[#0d0d0f] flex flex-col items-center justify-center px-4">
        <div className="text-white/60 animate-pulse">Redirecting...</div>
      </main>
    );
  }

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
        <div className="w-16" />
      </animated.header>

      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-4 pb-20">
        <div className="w-full max-w-[400px] flex flex-col items-center">
          {step === "SELECT_METHOD" && (
            <>
              <animated.div style={titleSpring} className="w-full mb-6">
                <div className="w-full px-4 py-3 rounded-xl bg-white/40 backdrop-blur-sm border border-white/60 flex items-start gap-3">
                  <div className="w-7 h-7 rounded-full bg-neutral-800 flex items-center justify-center shrink-0 mt-0.5 text-[10px] font-bold text-white">
                    E
                  </div>
                  <p className="text-sm text-neutral-700 leading-relaxed">
                    Hi! I'm Eliza. Connect below and I'll have your personal AI
                    space ready — we can talk while it warms up.
                  </p>
                </div>
              </animated.div>

              <animated.div style={titleSpring}>
                <h1 className="text-2xl sm:text-3xl font-bold text-neutral-900 text-center mb-2 whitespace-nowrap">
                  Anywhere you want her to be.
                </h1>
                <p className="text-neutral-600 text-center mb-8">
                  Choose your path(s)
                </p>
              </animated.div>

              {(discordError || telegramError) && (
                <div className="w-full mb-4 p-3 rounded-xl bg-red-50 border border-red-200">
                  <p className="text-sm text-red-600 text-center">
                    {discordError || telegramError}
                  </p>
                </div>
              )}

              <div className="w-full flex flex-col gap-3">
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

              <Button
                onClick={handleOpenMessages}
                className="w-full h-[52px] rounded-xl bg-[#34C759] hover:bg-[#2DB84D] text-white font-medium gap-2"
              >
                <AppleMessagesIcon className="size-5" />
                Open iMessage
              </Button>

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

          {step === "PROVISIONING_CHAT" && (
            <ProvisioningChatStep onContinue={() => navigate("/connected")} />
          )}

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
                <div className="w-full flex flex-col items-center gap-3">
                  <div className="text-neutral-500 animate-pulse text-sm">
                    Setting up...
                  </div>
                </div>
              ) : (
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

      <footer className="relative z-10 p-4 text-center">
        <p className="text-[10px] text-neutral-400">
          ElizaCloud Inc. {new Date().getFullYear()}
        </p>
      </footer>
    </main>
  );
}
