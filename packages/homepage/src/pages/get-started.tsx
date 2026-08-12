/**
 * Homepage onboarding page for connecting messaging platforms and starting an
 * Eliza Cloud session.
 */
import { BRAND_COLORS } from "@elizaos/shared/brand";
import { Button } from "@elizaos/ui/button";
import {
  DiscordIcon,
  IMessageIcon,
  TelegramIcon,
  WhatsAppIcon,
} from "@elizaos/ui/cloud-ui/components/icons";
import { ArrowLeft, Check, Copy, ExternalLink, Info, Send } from "lucide-react";
import {
  type CSSProperties,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ElizaLogo } from "@/components/brand/eliza-logo";
import {
  buildFullPhoneNumber,
  PhoneNumberInput,
  useCountryOptions,
} from "@/components/login/phone-number-input";
import {
  clearRememberedReturnTo,
  peekReturnTo,
  rememberReturnTo,
} from "@/lib/auth-return";
import { resolveOnboardingEntryStep } from "@/lib/onboarding-continuation";
import { useT } from "@/providers/I18nProvider";

// Defer the WebGL shader background so the form UI is interactive immediately.
const ShaderBackground = lazy(
  () => import("@/components/ShaderBackground/ShaderBackground"),
);

import { elizacloudAuthFetch } from "@/lib/api/client";
import {
  buildElizaSmsHref,
  buildElizaTelegramHref,
  ELIZA_PHONE_FORMATTED,
  ELIZA_PHONE_NUMBER,
  getDiscordBotApplicationId,
  getTelegramBotUsername,
  getWhatsAppNumber,
} from "@/lib/contact";
import {
  getAuthToken,
  type TelegramAuthData,
  useAuth,
} from "@/lib/context/auth-context";
import { getTelegramLinkDestination } from "@/lib/telegram-onboarding";

function SolanaIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 128 128"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <linearGradient id="sol-grad" x1="0%" x2="100%" y1="50%" y2="50%">
          <stop offset="0%" stopColor="#9945FF" />
          <stop offset="100%" stopColor="#14F195" />
        </linearGradient>
      </defs>
      <path
        fill="url(#sol-grad)"
        d="M23.9 87.3c.8-.8 1.9-1.3 3.1-1.3h97.8c1.9 0 2.9 2.3 1.5 3.7l-19.3 19.3c-.8.8-1.9 1.3-3.1 1.3H5.1c-1.9 0-2.9-2.3-1.5-3.7zm0-72.1c.8-.8 1.9-1.3 3.1-1.3h97.8c1.9 0 2.9 2.3 1.5 3.7L107.1 36.9c-.8.8-1.9 1.3-3.1 1.3H5.1c-1.9 0-2.9-2.3-1.5-3.7zm80.3 36c-.8-.8-1.9-1.3-3.1-1.3H3.3c-1.9 0-2.9 2.3-1.5 3.7l19.3 19.3c.8.8 1.9 1.3 3.1 1.3h97.8c1.9 0 2.9-2.3 1.5-3.7z"
      />
    </svg>
  );
}

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
/**
 * Preserves a platform onboarding continuation across the Discord OAuth
 * round-trip. Discord requires an exact-match redirect_uri, so the
 * onboardingSession query parameter cannot survive the redirect on the URL
 * itself; without this the DM session is orphaned after login and the user's
 * platform chat never continues into their provisioned agent.
 */
const ONBOARDING_SESSION_STORAGE_KEY = "eliza_onboarding_session_continuation";

function generateOAuthState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

type OnboardingMethod =
  | "telegram"
  | "imessage"
  | "discord"
  | "whatsapp"
  | "solana";

type OnboardingStep =
  | "SELECT_METHOD"
  | "ONBOARDING_SIGN_IN"
  | "CONTINUATION_LINK"
  | "TELEGRAM_DIRECT"
  | "TELEGRAM_OAUTH"
  | "PHONE_INPUT"
  | "IMESSAGE_DIRECT"
  | "WHATSAPP_DIRECT"
  | "DISCORD_CALLBACK"
  | "DISCORD_SETUP_GUIDE"
  | "PROVISIONING_CHAT";

function getTelegramBotId(): string {
  return (import.meta.env.VITE_TELEGRAM_BOT_ID || "").trim();
}

function getDiscordClientId(): string {
  return (import.meta.env.VITE_DISCORD_CLIENT_ID || "").trim();
}

const SANS = "Geist, system-ui, sans-serif";

/**
 * Static fallback that echoes the landing-page shader palette so pre-shader
 * frames (loading / redirect states) feel like the same surface instead of
 * flashing a different brand color.
 */
const PASTEL_FALLBACK: CSSProperties = {
  background:
    "linear-gradient(160deg, #efedf7 0%, #e4e2f1 40%, #eadfe9 75%, #e7e9ef 100%)",
  fontFamily: SANS,
};

const SOLANA_GRADIENT = "linear-gradient(135deg, #9945ff 0%, #14f195 100%)";

/** Landing-page glass tile language: white hairline + frosted fill. */
const GLASS_TILE = "border border-white/60 bg-white/35 backdrop-blur-md";

/**
 * Post-auth identity-link handoff for platform onboarding continuations.
 *
 * Mirrors the #18161 preview/confirm contract already served by the cloud-app
 * hosts: GET the continuation preview (read-only), require an explicit,
 * informed confirmation, then POST the redemption with
 * `confirmPlatformLink: true` — the turn that binds the session, links the
 * messaging identity, and starts provisioning. The terminal state prompts the
 * user back to the originating platform instead of a web chat: their
 * conversation lives there, and authenticated browser turns on a trusted
 * messaging session require the confirm flag.
 *
 * Non-linkable sessions (for example SMS-originated ones, which auto-link by
 * phone) fail the preview and fall back to the provisioning chat —
 * the exact pre-existing behavior for those platforms.
 */
function ContinuationLinkStep({
  onboardingSessionId,
  onFallbackToChat,
}: {
  onboardingSessionId: string;
  onFallbackToChat: () => void;
}) {
  const t = useT();
  const [phase, setPhase] = useState<
    "checking" | "confirm" | "linking" | "done" | "error"
  >("checking");
  const [error, setError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<{
    platform: "discord" | "telegram";
    platformUserId: string;
    platformDisplayName: string;
  } | null>(null);
  // StrictMode double-mount guard: the read-only preview should run once.
  const startedRef = useRef(false);

  const loadPreview = useCallback(async () => {
    setPhase("checking");
    setError(null);
    try {
      const res = await elizacloudAuthFetch<{
        success?: boolean;
        data?: {
          platform?: string;
          platformUserId?: string;
          platformDisplayName?: string;
        };
      }>("/api/eliza-app/onboarding/chat", {
        params: { sessionId: onboardingSessionId },
      });
      const preview = res?.data;
      if (
        (preview?.platform === "discord" || preview?.platform === "telegram") &&
        preview.platformUserId &&
        preview.platformDisplayName
      ) {
        setIdentity({
          platform: preview.platform,
          platformUserId: preview.platformUserId,
          platformDisplayName: preview.platformDisplayName,
        });
        setPhase("confirm");
        return;
      }
      throw new Error("The connection preview returned an invalid response.");
    } catch (err) {
      if (
        err instanceof Error &&
        /^elizacloud API error (403|404):/.test(err.message)
      ) {
        // The API uses a deliberate forbidden/not-found response when this is
        // a phone-shaped continuation rather than a browser-linkable account.
        onFallbackToChat();
        return;
      }
      setError(
        t("homepage_eliza.getStarted.continuationPreviewError", {
          defaultValue:
            "We couldn't check this connection. Try again without leaving this page.",
        }),
      );
      setPhase("error");
    }
  }, [onboardingSessionId, onFallbackToChat, t]);

  const confirmLink = useCallback(async () => {
    setPhase("linking");
    setError(null);
    try {
      await elizacloudAuthFetch("/api/eliza-app/onboarding/chat", {
        method: "POST",
        body: JSON.stringify({
          sessionId: onboardingSessionId,
          platform: "web",
          confirmPlatformLink: true,
        }),
      });
      setPhase("done");
    } catch (err) {
      setError(
        err instanceof Error && err.message.trim()
          ? err.message
          : t("homepage_eliza.getStarted.continuationLinkError", {
              defaultValue:
                "Could not finish connecting your account. Try again.",
            }),
      );
      setPhase("error");
    }
  }, [onboardingSessionId, t]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void loadPreview();
  }, [loadPreview]);

  if (phase === "confirm" && identity) {
    const platformLabel =
      identity.platform === "telegram" ? "Telegram" : "Discord";
    const PlatformIcon =
      identity.platform === "telegram" ? TelegramIcon : DiscordIcon;
    return (
      <div
        className="w-full flex flex-col items-center rounded-xs border border-white/80 bg-white/85 backdrop-blur-xl p-8 shadow-xl"
        data-testid="continuation-confirm"
      >
        <div className="w-16 h-16 rounded-xs bg-orange-500/15 flex items-center justify-center mb-6">
          <PlatformIcon className="size-8 text-orange-800" />
        </div>
        <h1 className="text-xl font-medium text-neutral-900 text-center mb-2">
          {t("homepage_eliza.getStarted.continuationConfirmTitle", {
            platform: platformLabel,
            defaultValue: `Connect your ${platformLabel} account?`,
          })}
        </h1>
        <p className="text-sm text-neutral-500 text-center mb-8">
          {t("homepage_eliza.getStarted.continuationConfirmBody", {
            defaultValue: "Continue as",
          })}{" "}
          <strong className="text-neutral-900">
            {identity.platformDisplayName}
          </strong>
          <span className="block text-xs text-neutral-400 mt-1">
            {platformLabel} ID {identity.platformUserId}
          </span>
        </p>
        <Button
          type="button"
          data-testid="continuation-confirm-button"
          onClick={() => void confirmLink()}
          className="w-full min-h-11 h-[52px] rounded-xs bg-orange-700 text-white font-medium hover:bg-orange-800"
        >
          {t("homepage_eliza.getStarted.continuationConfirmCta", {
            platform: platformLabel,
            defaultValue: `Connect this ${platformLabel} account`,
          })}
        </Button>
      </div>
    );
  }

  if (phase === "done") {
    const platform = identity?.platform ?? "discord";
    const platformLabel = platform === "telegram" ? "Telegram" : "Discord";
    const PlatformIcon = platform === "telegram" ? TelegramIcon : DiscordIcon;
    const platformHref =
      platform === "telegram"
        ? buildElizaTelegramHref()
        : "https://discord.com/channels/@me";
    return (
      <div
        className="w-full flex flex-col items-center rounded-xs border border-white/80 bg-white/85 backdrop-blur-xl p-8 shadow-xl"
        data-testid="continuation-done"
      >
        <div className="w-16 h-16 rounded-xs bg-orange-500/15 flex items-center justify-center mb-6">
          <Check className="size-8 text-orange-800" />
        </div>
        <h1 className="text-xl font-medium text-neutral-900 text-center mb-2">
          {t("homepage_eliza.getStarted.continuationDoneTitle", {
            defaultValue: "You're connected",
          })}
        </h1>
        <p className="text-sm text-neutral-500 text-center mb-8">
          {t("homepage_eliza.getStarted.continuationDoneBody", {
            platform: platformLabel,
            defaultValue: `Head back to ${platformLabel} — Eliza is getting your agent ready and will pick up right where you left off.`,
          })}
        </p>
        <Button
          asChild
          className="w-full min-h-11 h-[52px] rounded-xs bg-orange-700 hover:bg-orange-800 text-white font-medium gap-2"
        >
          <a
            href={platformHref}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`continuation-open-${platform}`}
          >
            <PlatformIcon className="size-5" />
            {t("homepage_eliza.getStarted.continuationOpenPlatform", {
              platform: platformLabel,
              defaultValue: `Open ${platformLabel}`,
            })}
          </a>
        </Button>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div
        className="w-full flex flex-col items-center rounded-xs border border-white/80 bg-white/85 backdrop-blur-xl p-8 shadow-xl"
        data-testid="continuation-error"
      >
        <h1 className="text-xl font-medium text-neutral-900 text-center mb-2">
          {t("homepage_eliza.getStarted.continuationErrorTitle", {
            defaultValue: "Couldn't connect your account",
          })}
        </h1>
        <p className="text-sm text-red-600 text-center mb-8">{error}</p>
        <Button
          type="button"
          onClick={() => void (identity ? confirmLink() : loadPreview())}
          className="w-full min-h-11 h-[52px] rounded-xs bg-orange-700 text-white font-medium hover:bg-orange-800"
        >
          {t("homepage_eliza.getStarted.tryAgain", {
            defaultValue: "Try Again",
          })}
        </Button>
      </div>
    );
  }

  return (
    <div
      className="w-full flex flex-col items-center rounded-xs border border-white/80 bg-white/85 backdrop-blur-xl p-8 shadow-xl"
      role="status"
      aria-busy="true"
      data-testid="continuation-checking"
    >
      <div className="text-neutral-500 animate-pulse text-sm">
        {phase === "linking"
          ? t("homepage_eliza.getStarted.continuationLinking", {
              defaultValue: "Connecting your account...",
            })
          : t("homepage_eliza.getStarted.continuationChecking", {
              defaultValue: "Checking your connection...",
            })}
      </div>
    </div>
  );
}

function ProvisioningChatStep({
  onboardingSessionId,
  onContinue,
}: {
  onboardingSessionId?: string | null;
  onContinue: () => void;
}) {
  const t = useT();
  const { messages, sendMessage, containerStatus, isLoading, isReady } =
    useElizaAppProvisioningChat(true, onboardingSessionId);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (messages.length === 0 && !isLoading) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, isLoading]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;
    setInput("");
    await sendMessage(text);
    inputRef.current?.focus();
  }, [input, isLoading, sendMessage]);

  const statusLabel = isReady
    ? t("homepage_eliza.getStarted.statusReady", {
        defaultValue: "Ready! Connecting...",
      })
    : containerStatus === "error"
      ? t("homepage_eliza.getStarted.statusFailed", {
          defaultValue: "Setup failed — please refresh.",
        })
      : t("homepage_eliza.getStarted.statusSettingUp", {
          defaultValue: "Setting up your AI space...",
        });

  const statusColor = isReady
    ? "#4ade80"
    : containerStatus === "error"
      ? "#f87171"
      : "#229ED9";

  return (
    <div style={{ width: "100%", maxWidth: "420px", fontFamily: SANS }}>
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
            {t("homepage_eliza.getStarted.skipToDashboard", {
              defaultValue: "Skip to dashboard",
            })}
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
          border: "1px solid rgba(255,255,255,0.6)",
          borderRadius: 20,
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
                color: msg.role === "user" ? BRAND_COLORS.white : "#1a1a1a",
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
          placeholder={
            isReady
              ? t("homepage_eliza.getStarted.chatPlaceholderReady", {
                  defaultValue: "Ready!",
                })
              : t("homepage_eliza.getStarted.chatPlaceholderAsk", {
                  defaultValue: "Ask me anything...",
                })
          }
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
            padding: "0 18px",
            borderRadius: 22,
            border: "1px solid rgba(255,255,255,0.6)",
            background: "rgba(255,255,255,0.5)",
            backdropFilter: "blur(8px)",
            fontSize: 14,
            fontFamily: SANS,
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
            borderRadius: 22,
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
          className="w-full h-[52px] rounded-full bg-neutral-900 text-white font-medium hover:bg-neutral-800 transition-colors mt-4"
        >
          <Check className="size-4 mr-2" />
          {t("homepage_eliza.getStarted.continueToDashboard", {
            defaultValue: "Continue to dashboard",
          })}
        </Button>
      )}
    </div>
  );
}

export default function GetStartedPage() {
  const navigate = useNavigate();
  const t = useT();
  const [searchParams] = useSearchParams();
  const {
    isAuthenticated,
    isLoading: authLoading,
    user,
    loginWithTelegram,
    loginWithDiscord,
    loginWithSolana,
  } = useAuth();

  const methodParam = searchParams.get("method") as OnboardingMethod | null;
  const urlOnboardingSessionId = searchParams.get("onboardingSession");
  const discordCode = searchParams.get("code");
  const discordState = searchParams.get("state");
  const discordOAuthError = searchParams.get("error");
  // Restore a continuation stashed before the Discord OAuth redirect. Read
  // once into state so clearing the storage key later cannot drop the session
  // id out from under an in-progress PROVISIONING_CHAT render.
  const [restoredOnboardingSession] = useState<string | null>(() =>
    typeof window !== "undefined" &&
    (discordCode ||
      (discordOAuthError &&
        discordState &&
        discordState === sessionStorage.getItem(DISCORD_OAUTH_STATE_KEY)))
      ? sessionStorage.getItem(ONBOARDING_SESSION_STORAGE_KEY)
      : null,
  );
  const onboardingSessionId =
    urlOnboardingSessionId ?? restoredOnboardingSession;
  const guideParam = searchParams.get("guide");
  const returnTo = searchParams.get("returnTo");
  const postAuthDestination = peekReturnTo(returnTo);
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

  const headerStyle: CSSProperties = {
    opacity: showContent ? 1 : 0,
    transform: showContent ? "translateY(0px)" : "translateY(-20px)",
    transition: "opacity 260ms ease 200ms, transform 260ms ease 200ms",
  };

  const titleStyle: CSSProperties = {
    opacity: showContent ? 1 : 0,
    transform: showContent ? "translateY(0px)" : "translateY(30px)",
    transition: "opacity 320ms ease 400ms, transform 320ms ease 400ms",
  };

  const cardStyle = (index: number): CSSProperties => ({
    opacity: showContent ? 1 : 0,
    transform: showContent
      ? "translateY(0px) scale(1)"
      : "translateY(40px) scale(0.95)",
    transition: `opacity 320ms ease ${600 + index * 70}ms, transform 320ms ease ${
      600 + index * 70
    }ms`,
  });

  const countryOptions = useCountryOptions();

  const hasPhoneNumber = phoneValue.trim().length > 0;

  const handleDiscordOAuthRedirect = useCallback((): boolean => {
    const clientId = getDiscordClientId();
    if (!clientId) {
      setDiscordError(
        t("homepage_eliza.getStarted.errDiscordNotConfigured", {
          defaultValue: "Discord not configured",
        }),
      );
      setIsRedirectingToOAuth(false);
      setStep("SELECT_METHOD");
      return false;
    }

    const state = generateOAuthState();
    sessionStorage.setItem(DISCORD_OAUTH_STATE_KEY, state);
    rememberReturnTo(returnTo);

    // Discord's exact-match redirect_uri drops query parameters, so an
    // in-flight platform onboarding continuation must survive the OAuth
    // round-trip via storage or the DM session is orphaned after login.
    if (onboardingSessionId && !isLinkMode) {
      sessionStorage.setItem(
        ONBOARDING_SESSION_STORAGE_KEY,
        onboardingSessionId,
      );
    } else {
      sessionStorage.removeItem(ONBOARDING_SESSION_STORAGE_KEY);
    }

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
  }, [isLinkMode, onboardingSessionId, returnTo, t]);

  useEffect(() => {
    if (
      !authLoading &&
      isAuthenticated &&
      !suppressRedirect &&
      !guideParam &&
      !onboardingSessionId &&
      !isLinkMode &&
      !discordCode &&
      step !== "PROVISIONING_CHAT"
    ) {
      clearRememberedReturnTo();
      navigate(postAuthDestination, { replace: true });
    }
  }, [
    isAuthenticated,
    authLoading,
    navigate,
    suppressRedirect,
    guideParam,
    onboardingSessionId,
    isLinkMode,
    discordCode,
    step,
    postAuthDestination,
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

    // Platform continuations (Discord DM "Connect" button, SMS link) never
    // see the connector picker — the visitor already came FROM a platform.
    // Signed-in visitors continue into the identity-link handoff; signed-out
    // visitors go straight to sign-in. Telegram continuations carry
    // method=telegram (handled below).
    const continuationStep = resolveOnboardingEntryStep({
      onboardingSessionId,
      isAuthenticated,
      isLinkMode,
      discordCode,
      methodParam,
    });
    if (continuationStep) {
      setInitialMethodHandled(true);
      if (continuationStep === "CONTINUATION_LINK") {
        setSuppressRedirect(true);
      }
      setStep(continuationStep);
      return;
    }

    if (isAuthenticated && !isLinkMode) return;

    if (discordCode && discordState) {
      const storedState = sessionStorage.getItem(DISCORD_OAUTH_STATE_KEY);
      if (!storedState || storedState !== discordState) {
        setInitialMethodHandled(true);
        setDiscordError(
          t("homepage_eliza.getStarted.errInvalidState", {
            defaultValue:
              "Authentication failed: invalid state. Please try again.",
          }),
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
        setStep(isLinkMode ? "TELEGRAM_OAUTH" : "TELEGRAM_DIRECT");
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
    onboardingSessionId,
    discordCode,
    discordState,
    guideParam,
    initialMethodHandled,
    authLoading,
    isAuthenticated,
    isLinkMode,
    handleDiscordOAuthRedirect,
    t,
  ]);

  useEffect(() => {
    if (!isLinkMode) return;

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
  }, [isLinkMode]);

  const getFullPhoneNumber = useCallback(() => {
    return buildFullPhoneNumber(phoneValue, selectedCountry, countryOptions);
  }, [phoneValue, selectedCountry, countryOptions]);

  const [solanaError, setSolanaError] = useState<string | null>(null);
  const [isSolanaLoading, setIsSolanaLoading] = useState(false);

  const handleSolanaConnect = useCallback(async () => {
    setSolanaError(null);
    setIsSolanaLoading(true);
    try {
      const result = await loginWithSolana();
      if (result.success) {
        if (onboardingSessionId && !isLinkMode) {
          // Platform continuation: continue into the identity-link handoff
          // with the new credentials instead of bouncing to the dashboard.
          setSuppressRedirect(true);
          setStep("CONTINUATION_LINK");
          return;
        }
        clearRememberedReturnTo();
        navigate(postAuthDestination, { replace: true });
      } else {
        setSolanaError(
          result.error ??
            t("homepage_eliza.getStarted.errSolanaSignIn", {
              defaultValue: "Solana sign-in failed",
            }),
        );
      }
    } catch (err) {
      setSolanaError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSolanaLoading(false);
    }
  }, [
    isLinkMode,
    loginWithSolana,
    navigate,
    onboardingSessionId,
    postAuthDestination,
    t,
  ]);

  const handleMethodSelect = (method: OnboardingMethod) => {
    setSelectedMethod(method);
    setPhoneError(null);
    setTelegramError(null);
    setDiscordError(null);
    setSolanaError(null);

    if (method === "telegram") {
      setStep(isLinkMode ? "TELEGRAM_OAUTH" : "TELEGRAM_DIRECT");
    } else if (method === "discord") {
      setIsRedirectingToOAuth(true);
      if (!handleDiscordOAuthRedirect()) {
        setSelectedMethod(null);
      }
    } else if (method === "whatsapp") {
      setStep("WHATSAPP_DIRECT");
    } else if (method === "solana") {
      void handleSolanaConnect();
    } else {
      setStep("IMESSAGE_DIRECT");
    }
  };

  const handleBack = () => {
    if (step === "TELEGRAM_DIRECT" || step === "TELEGRAM_OAUTH") {
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
    } else if (step === "ONBOARDING_SIGN_IN" || step === "CONTINUATION_LINK") {
      navigate("/");
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
      setTelegramError(
        t("homepage_eliza.getStarted.errTelegramNotConfigured", {
          defaultValue: "Telegram not configured",
        }),
      );
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
      setTelegramError(
        t("homepage_eliza.getStarted.errTelegramWidget", {
          defaultValue: "Telegram widget not loaded. Please refresh the page.",
        }),
      );
    }
  }, [handleTelegramAuthCallback, t]);

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
      onboardingSessionId,
    );

    if (result.success) {
      if (isLinkMode) {
        if (onboardingSessionId && !result.continuationRedeemed) {
          setPhoneError(
            t("homepage_eliza.getStarted.errTelegramContinuation", {
              defaultValue:
                "We couldn't finish linking this Telegram chat. Return to the bot and request a new link.",
            }),
          );
          setIsSubmittingPhone(false);
          return;
        }
        clearRememberedReturnTo();
        navigate(
          getTelegramLinkDestination(result.continuationRedeemed === true),
          {
            replace: true,
          },
        );
      } else {
        setStep("PROVISIONING_CHAT");
      }
    } else {
      if (result.errorCode === "PHONE_ALREADY_LINKED") {
        setPhoneError(
          t("homepage_eliza.connected.errorPhoneAlreadyLinked", {
            defaultValue:
              "This phone number is already linked to another account. Please use a different number.",
          }),
        );
      } else if (result.errorCode === "PHONE_MISMATCH") {
        setPhoneError(
          t("homepage_eliza.getStarted.errPhoneMismatch", {
            defaultValue:
              "Your Telegram account is already linked to a different phone number.",
          }),
        );
      } else if (result.errorCode === "TELEGRAM_ALREADY_LINKED") {
        setTelegramError(
          t("homepage_eliza.getStarted.errTelegramAlreadyLinked", {
            defaultValue:
              "This Telegram account is already linked to another user.",
          }),
        );
        setStep("SELECT_METHOD");
      } else if (result.errorCode === "INVALID_AUTH") {
        setTelegramError(
          t("homepage_eliza.getStarted.errTelegramAuthExpired", {
            defaultValue: "Telegram authentication expired. Please try again.",
          }),
        );
        setStep("SELECT_METHOD");
      } else {
        setPhoneError(
          result.error ||
            t("homepage_eliza.connected.errorGeneric", {
              defaultValue: "Something went wrong. Please try again.",
            }),
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
    onboardingSessionId,
    navigate,
    t,
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
        // The continuation id (if any) already lives in component state; the
        // storage copy has served its purpose across the OAuth round-trip.
        sessionStorage.removeItem(ONBOARDING_SESSION_STORAGE_KEY);
        if (isLinkMode) {
          navigate("/connected", { replace: true });
        } else if (onboardingSessionId) {
          // Platform continuation: the login itself does not redeem the
          // session — continue into the preview/confirm identity-link
          // handoff, whose terminal state prompts the user back to Discord.
          setStep("CONTINUATION_LINK");
        } else {
          setStep("PROVISIONING_CHAT");
        }
      } else {
        setSuppressRedirect(false);
        if (result.errorCode === "PHONE_ALREADY_LINKED") {
          setPhoneError(
            t("homepage_eliza.connected.errorPhoneAlreadyLinked", {
              defaultValue:
                "This phone number is already linked to another account. Please use a different number.",
            }),
          );
        } else if (result.errorCode === "DISCORD_ALREADY_LINKED") {
          setDiscordError(
            t("homepage_eliza.getStarted.errDiscordAlreadyLinked", {
              defaultValue:
                "This Discord account is already linked to another user. Please use a different Discord account or contact support.",
            }),
          );
        } else if (result.errorCode === "INVALID_AUTH") {
          setDiscordError(
            t("homepage_eliza.getStarted.errDiscordAuthFailed", {
              defaultValue:
                "Discord authentication failed or expired. Please try again.",
            }),
          );
        } else {
          setDiscordError(
            result.error ||
              t("homepage_eliza.connected.errorGeneric", {
                defaultValue: "Something went wrong. Please try again.",
              }),
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
      onboardingSessionId,
      t,
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
    clearRememberedReturnTo();
    navigate(postAuthDestination);
  };

  if (authLoading) {
    return (
      <main
        className="min-h-screen flex flex-col items-center justify-center px-4"
        style={PASTEL_FALLBACK}
      >
        <div className="text-neutral-600 animate-pulse font-medium">
          {t("homepage_eliza.common.loading", { defaultValue: "Loading…" })}
        </div>
      </main>
    );
  }

  if (
    isAuthenticated &&
    !suppressRedirect &&
    !isLinkMode &&
    !guideParam &&
    !onboardingSessionId &&
    !discordCode &&
    step !== "PROVISIONING_CHAT"
  ) {
    return (
      <main
        className="min-h-screen flex flex-col items-center justify-center px-4"
        style={PASTEL_FALLBACK}
      >
        <div className="text-neutral-600 animate-pulse font-medium">
          {t("homepage_eliza.common.redirecting", {
            defaultValue: "Redirecting…",
          })}
        </div>
      </main>
    );
  }

  if (isRedirectingToOAuth) {
    return (
      <main
        className="min-h-screen flex flex-col items-center justify-center px-4"
        style={PASTEL_FALLBACK}
      >
        <div className="text-neutral-600 animate-pulse font-medium">
          {t("homepage_eliza.getStarted.redirectingToDiscord", {
            defaultValue: "Redirecting to Discord…",
          })}
        </div>
      </main>
    );
  }

  return (
    <main
      className="min-h-screen flex flex-col relative"
      style={{ fontFamily: SANS }}
    >
      <Suspense fallback={null}>
        <ShaderBackground />
      </Suspense>
      <div
        aria-hidden="true"
        className="fixed inset-0 pointer-events-none mix-blend-overlay bg-[url('/grain.webp')] z-0"
      />
      <header
        className="relative z-10 p-4 flex items-center justify-between"
        style={headerStyle}
      >
        <div className="w-24">
          {step === "DISCORD_SETUP_GUIDE" ? null : step !== "SELECT_METHOD" ? (
            <button
              type="button"
              onClick={handleBack}
              className={`inline-flex min-h-11 items-center gap-1.5 rounded-full ${GLASS_TILE} hover:bg-white/60 px-4 text-neutral-700 hover:text-neutral-900 transition-colors cursor-pointer`}
            >
              <ArrowLeft className="size-4" />
              <span className="text-sm font-medium">
                {t("homepage_eliza.getStarted.back", { defaultValue: "Back" })}
              </span>
            </button>
          ) : (
            <Link
              to="/"
              className={`inline-flex min-h-11 items-center gap-1.5 rounded-full ${GLASS_TILE} hover:bg-white/60 px-4 text-neutral-700 hover:text-neutral-900 transition-colors`}
            >
              <ArrowLeft className="size-4" />
              <span className="text-sm font-medium">
                {t("homepage_eliza.getStarted.home", { defaultValue: "Home" })}
              </span>
            </Link>
          )}
        </div>

        <ElizaLogo variant="svg" className="h-8 w-auto" />
        <div className="w-24" />
      </header>

      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-4 pb-20">
        <div className="w-full max-w-[400px] flex flex-col items-center">
          {step === "ONBOARDING_SIGN_IN" && (
            <>
              <div style={titleStyle}>
                <h1 className="text-2xl sm:text-3xl font-bold text-neutral-900 text-center mb-2">
                  {t("homepage_eliza.getStarted.onboardingSignInTitle", {
                    defaultValue: "Sign in to continue",
                  })}
                </h1>
                <p className="text-sm text-neutral-500 text-center mb-8">
                  {t("homepage_eliza.getStarted.onboardingSignInSubtitle", {
                    defaultValue:
                      "Your chat is waiting — sign in and it picks up right where you left off.",
                  })}
                </p>
              </div>

              {(discordError || solanaError) && (
                <div className="w-full mb-4 p-3 rounded-xs bg-red-50 border border-red-200">
                  <p className="text-sm text-red-600 text-center">
                    {discordError || solanaError}
                  </p>
                </div>
              )}

              <div className="w-full flex flex-col gap-3">
                <button
                  type="button"
                  data-testid="onboarding-signin-discord"
                  onClick={() => handleMethodSelect("discord")}
                  className="w-full min-h-11 h-[72px] bg-orange-600 hover:bg-orange-700 text-white rounded-xs transition-colors flex items-center gap-4 px-5 cursor-pointer"
                  style={cardStyle(0)}
                >
                  <div className="w-12 h-12 rounded-xs bg-white/15 flex items-center justify-center shrink-0">
                    <DiscordIcon className="size-6 text-white" />
                  </div>
                  <div className="flex-1 text-left">
                    <p className="font-medium">
                      {t("homepage_eliza.getStarted.onboardingSignInDiscord", {
                        defaultValue: "Continue with Discord",
                      })}
                    </p>
                  </div>
                </button>

                <button
                  type="button"
                  aria-label={t("homepage_eliza.getStarted.solanaAria", {
                    defaultValue: "Sign in with Solana",
                  })}
                  data-testid="onboarding-signin-solana"
                  disabled={isSolanaLoading}
                  onClick={() => handleMethodSelect("solana")}
                  className="w-full h-[72px] bg-white hover:bg-black text-black hover:text-white rounded-xs transition-colors flex items-center gap-4 px-5 cursor-pointer disabled:opacity-60"
                  style={cardStyle(1)}
                >
                  <div
                    className="w-12 h-12 rounded-xs flex items-center justify-center shrink-0"
                    style={{ background: SOLANA_GRADIENT }}
                  >
                    <SolanaIcon className="size-6 text-white" />
                  </div>
                  <div className="flex-1 text-left">
                    <p className="font-medium">
                      {isSolanaLoading
                        ? t("homepage_eliza.getStarted.btnSolanaLoading", {
                            defaultValue: "Connecting…",
                          })
                        : t("homepage_eliza.getStarted.btnSolana", {
                            defaultValue: "Solana Wallet",
                          })}
                    </p>
                  </div>
                </button>
              </div>

              <button
                type="button"
                data-testid="onboarding-signin-more"
                onClick={() => setStep("SELECT_METHOD")}
                className="w-full mt-6 text-sm text-neutral-500 hover:text-neutral-700 cursor-pointer"
                style={cardStyle(2)}
              >
                {t("homepage_eliza.getStarted.onboardingSignInMore", {
                  defaultValue: "More ways to connect",
                })}
              </button>
            </>
          )}

          {step === "SELECT_METHOD" && (
            <>
              <div style={titleStyle}>
                <h1 className="text-2xl sm:text-[1.75rem] font-medium tracking-tight text-neutral-900 text-center mb-2 text-balance">
                  {t("homepage_eliza.getStarted.selectHeader", {
                    defaultValue: "Anywhere you want her to be.",
                  })}
                </h1>
                <p className="text-sm font-medium text-neutral-700 text-center mb-10 text-balance">
                  {t("homepage_eliza.getStarted.selectSubheader", {
                    defaultValue: "Pick where you want to talk to Eliza.",
                  })}
                </p>
              </div>

              {(discordError || telegramError) && (
                <div className="w-full mb-4 p-3 rounded-2xl bg-red-50/80 border border-red-200">
                  <p className="text-sm text-red-600 text-center">
                    {discordError || telegramError}
                  </p>
                </div>
              )}

              <div className="w-full flex flex-col gap-3">
                <button
                  type="button"
                  onClick={() => handleMethodSelect("telegram")}
                  className={`w-full h-16 ${GLASS_TILE} hover:bg-white/60 rounded-full transition-colors flex items-center gap-4 pl-2.5 pr-6 cursor-pointer`}
                  style={cardStyle(0)}
                >
                  <div className="size-11 rounded-full bg-white/60 flex items-center justify-center shrink-0">
                    <TelegramIcon className="size-6 text-[#2AABEE]" />
                  </div>
                  <div className="flex-1 text-left">
                    <p className="font-medium text-neutral-900">
                      {t("homepage_eliza.getStarted.btnTelegram", {
                        defaultValue: "Telegram",
                      })}
                    </p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => handleMethodSelect("imessage")}
                  className={`w-full h-16 ${GLASS_TILE} hover:bg-white/60 rounded-full transition-colors flex items-center gap-4 pl-2.5 pr-6 cursor-pointer`}
                  style={cardStyle(1)}
                >
                  <div className="size-11 rounded-full bg-white/60 flex items-center justify-center shrink-0">
                    <IMessageIcon className="size-6 text-[#34C759]" />
                  </div>
                  <div className="flex-1 text-left">
                    <p className="font-medium text-neutral-900">
                      {t("homepage_eliza.getStarted.btnImessage", {
                        defaultValue: "iMessage",
                      })}
                    </p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => handleMethodSelect("whatsapp")}
                  className={`w-full h-16 ${GLASS_TILE} hover:bg-white/60 rounded-full transition-colors flex items-center gap-4 pl-2.5 pr-6 cursor-pointer`}
                  style={cardStyle(2)}
                >
                  <div className="size-11 rounded-full bg-white/60 flex items-center justify-center shrink-0">
                    <WhatsAppIcon className="size-6 text-[#25D366]" />
                  </div>
                  <div className="flex-1 text-left">
                    <p className="font-medium text-neutral-900">
                      {t("homepage_eliza.getStarted.btnWhatsapp", {
                        defaultValue: "WhatsApp",
                      })}
                    </p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => handleMethodSelect("discord")}
                  className={`w-full h-16 ${GLASS_TILE} hover:bg-white/60 rounded-full transition-colors flex items-center gap-4 pl-2.5 pr-6 cursor-pointer`}
                  style={cardStyle(3)}
                >
                  <div className="size-11 rounded-full bg-white/60 flex items-center justify-center shrink-0">
                    <DiscordIcon className="size-6 text-[#5865F2]" />
                  </div>
                  <div className="flex-1 text-left">
                    <p className="font-medium text-neutral-900">
                      {t("homepage_eliza.getStarted.btnDiscord", {
                        defaultValue: "Discord",
                      })}
                    </p>
                  </div>
                </button>

                <button
                  type="button"
                  aria-label={t("homepage_eliza.getStarted.solanaAria", {
                    defaultValue: "Sign in with Solana",
                  })}
                  data-testid="solana-signin"
                  disabled={isSolanaLoading}
                  onClick={() => handleMethodSelect("solana")}
                  className={`w-full h-16 ${GLASS_TILE} hover:bg-white/60 rounded-full transition-colors flex items-center gap-4 pl-2.5 pr-6 cursor-pointer disabled:opacity-60`}
                  style={cardStyle(4)}
                >
                  <div className="size-11 rounded-full bg-white/60 flex items-center justify-center shrink-0">
                    <SolanaIcon className="size-5" />
                  </div>
                  <div className="flex-1 text-left">
                    <p className="font-medium text-neutral-900">
                      {isSolanaLoading
                        ? t("homepage_eliza.getStarted.btnSolanaLoading", {
                            defaultValue: "Connecting…",
                          })
                        : t("homepage_eliza.getStarted.btnSolana", {
                            defaultValue: "Solana Wallet",
                          })}
                    </p>
                  </div>
                </button>
                {solanaError && (
                  <p
                    role="alert"
                    data-testid="solana-error"
                    className="text-sm text-red-600 text-center mt-1"
                  >
                    {solanaError}
                  </p>
                )}
              </div>
            </>
          )}

          {step === "TELEGRAM_DIRECT" && (
            <>
              <div
                className={`w-16 h-16 rounded-full ${GLASS_TILE} flex items-center justify-center mb-6`}
              >
                <TelegramIcon className="size-8 text-[#2AABEE]" />
              </div>

              <h1 className="text-xl font-semibold tracking-tight text-neutral-900 text-center mb-2">
                {t("homepage_eliza.getStarted.telegramDirectTitle", {
                  defaultValue: "Message Eliza on Telegram",
                })}
              </h1>
              <p className="text-sm text-neutral-500 text-center mb-8">
                {t("homepage_eliza.getStarted.telegramDirectSubtitle", {
                  defaultValue:
                    "Open Telegram, press Start, and send Eliza a message.",
                })}
              </p>

              <Button
                asChild
                className="w-full h-[52px] rounded-full bg-neutral-900 hover:bg-neutral-800 text-white font-medium gap-2"
              >
                <a
                  href={buildElizaTelegramHref()}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <TelegramIcon className="size-5" />
                  {t("homepage_eliza.getStarted.openTelegram", {
                    defaultValue: "Open Telegram",
                  })}
                  <ExternalLink className="size-4 ml-1" />
                </a>
              </Button>
            </>
          )}

          {step === "TELEGRAM_OAUTH" && (
            <>
              <div
                className={`w-16 h-16 rounded-full ${GLASS_TILE} flex items-center justify-center mb-6`}
              >
                <TelegramIcon className="size-8 text-[#2AABEE]" />
              </div>

              <h1 className="text-xl font-semibold tracking-tight text-neutral-900 text-center mb-2">
                {t("homepage_eliza.getStarted.telegramTitle", {
                  defaultValue: "Connect with Telegram",
                })}
              </h1>
              <p className="text-sm text-neutral-500 text-center mb-8">
                {t("homepage_eliza.getStarted.telegramSubtitle", {
                  defaultValue:
                    "Sign in with your Telegram account to get started",
                })}
              </p>

              {telegramError && (
                <p className="text-sm text-red-500 text-center mb-4">
                  {telegramError}
                </p>
              )}

              <Button
                onClick={handleTelegramClick}
                disabled={isTelegramLoading}
                className="w-full h-[52px] rounded-full bg-neutral-900 hover:bg-neutral-800 text-white font-medium gap-2"
              >
                {isTelegramLoading ? (
                  t("homepage_eliza.getStarted.telegramConnecting", {
                    defaultValue: "Connecting...",
                  })
                ) : (
                  <>
                    <TelegramIcon className="size-5" />
                    {t("homepage_eliza.getStarted.telegramConnectBtn", {
                      defaultValue: "Connect Telegram",
                    })}
                  </>
                )}
              </Button>
            </>
          )}

          {step === "PHONE_INPUT" && (
            <>
              <div
                className={`w-12 h-12 rounded-full ${GLASS_TILE} flex items-center justify-center mb-6`}
              >
                <TelegramIcon className="size-6 text-[#2AABEE]" />
              </div>

              <h1 className="text-xl font-semibold tracking-tight text-neutral-900 text-center mb-2">
                {t("homepage_eliza.getStarted.phoneTitle", {
                  defaultValue: "Almost there!",
                })}
              </h1>
              <p className="text-sm text-neutral-500 text-center mb-8">
                {t("homepage_eliza.getStarted.phoneSubtitle", {
                  defaultValue:
                    "Enter your phone number to enable iMessage and prevent bots",
                })}
              </p>

              <div className="w-full mb-4">
                <PhoneNumberInput
                  selectedCountry={selectedCountry}
                  onCountryChange={setSelectedCountry}
                  phoneValue={phoneValue}
                  onPhoneChange={setPhoneValue}
                  onSubmit={handlePhoneSubmit}
                  variant="glass"
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
                className={`w-full h-[52px] rounded-full font-medium transition-colors ${
                  hasPhoneNumber
                    ? "bg-neutral-900 text-white hover:bg-neutral-800"
                    : "bg-white/40 border border-white/60 text-neutral-400 cursor-not-allowed"
                }`}
              >
                {isSubmittingPhone
                  ? t("homepage_eliza.getStarted.settingUp", {
                      defaultValue: "Setting up...",
                    })
                  : t("homepage_eliza.getStarted.completeSetup", {
                      defaultValue: "Complete Setup",
                    })}
              </Button>
            </>
          )}

          {step === "IMESSAGE_DIRECT" && (
            <>
              <div
                className={`w-16 h-16 rounded-full ${GLASS_TILE} flex items-center justify-center mb-6`}
              >
                <IMessageIcon className="size-8 text-[#34C759]" />
              </div>

              <h1 className="text-xl font-semibold tracking-tight text-neutral-900 text-center mb-2">
                {t("homepage_eliza.getStarted.imessageReady", {
                  defaultValue: "Ready to chat!",
                })}
              </h1>
              <p className="text-sm text-neutral-500 text-center mb-6">
                {t("homepage_eliza.getStarted.imessageSubtitle", {
                  defaultValue:
                    "Just text this number to start talking with Eliza",
                })}
              </p>

              <div className={`w-full p-4 ${GLASS_TILE} rounded-2xl mb-6`}>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-lg font-medium tabular-nums tracking-wide text-neutral-900">
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
                className="w-full h-[52px] rounded-full bg-neutral-900 hover:bg-neutral-800 text-white font-medium gap-2"
              >
                <IMessageIcon className="size-5 text-[#34C759]" />
                {t("homepage_eliza.getStarted.openImessage", {
                  defaultValue: "Open iMessage",
                })}
              </Button>

              <button
                type="button"
                onClick={() => {
                  setSelectedMethod("telegram");
                  setStep("TELEGRAM_DIRECT");
                }}
                className="w-full mt-4 text-sm text-neutral-500 hover:text-neutral-700"
              >
                {t("homepage_eliza.getStarted.alsoTelegram", {
                  defaultValue: "I also want to use Telegram",
                })}
              </button>
            </>
          )}

          {step === "WHATSAPP_DIRECT" && (
            <>
              <div
                className={`w-16 h-16 rounded-full ${GLASS_TILE} flex items-center justify-center mb-6`}
              >
                <WhatsAppIcon className="size-8 text-[#25D366]" />
              </div>

              <h1 className="text-xl font-semibold tracking-tight text-neutral-900 text-center mb-2">
                {t("homepage_eliza.getStarted.whatsappTitle", {
                  defaultValue: "Chat on WhatsApp!",
                })}
              </h1>
              <p className="text-sm text-neutral-500 text-center mb-6">
                {t("homepage_eliza.getStarted.whatsappSubtitle", {
                  defaultValue:
                    "Message our WhatsApp number to start talking with Eliza",
                })}
              </p>

              <Button
                onClick={() => {
                  const waNumber = getWhatsAppNumber().replace(/\D/g, "");
                  window.open(`https://wa.me/${waNumber}`, "_blank");
                }}
                className="w-full h-[52px] rounded-full bg-neutral-900 hover:bg-neutral-800 text-white font-medium gap-2"
              >
                <WhatsAppIcon className="size-5 text-[#25D366]" />
                {t("homepage_eliza.getStarted.openWhatsapp", {
                  defaultValue: "Open WhatsApp",
                })}
                <ExternalLink className="size-4 ml-1" />
              </Button>

              <button
                type="button"
                onClick={() => {
                  setSelectedMethod("telegram");
                  setStep("TELEGRAM_DIRECT");
                }}
                className="w-full mt-4 text-sm text-neutral-500 hover:text-neutral-700"
              >
                {t("homepage_eliza.getStarted.alsoTelegram", {
                  defaultValue: "I also want to use Telegram",
                })}
              </button>
            </>
          )}

          {step === "CONTINUATION_LINK" && onboardingSessionId && (
            <ContinuationLinkStep
              onboardingSessionId={onboardingSessionId}
              onFallbackToChat={() => setStep("PROVISIONING_CHAT")}
            />
          )}

          {step === "PROVISIONING_CHAT" && (
            <ProvisioningChatStep
              onboardingSessionId={onboardingSessionId}
              onContinue={() => {
                clearRememberedReturnTo();
                navigate(postAuthDestination);
              }}
            />
          )}

          {step === "DISCORD_CALLBACK" && (
            <>
              <div
                className={`w-16 h-16 rounded-full ${discordError ? "border border-red-200 bg-red-100/70 backdrop-blur-md" : GLASS_TILE} flex items-center justify-center mb-6`}
              >
                <DiscordIcon
                  className={`size-8 ${discordError ? "text-red-500" : "text-[#5865F2]"}`}
                />
              </div>

              <h1 className="text-xl font-semibold tracking-tight text-neutral-900 text-center mb-2">
                {discordError
                  ? t("homepage_eliza.getStarted.discordCbConnectionFailed", {
                      defaultValue: "Connection Failed",
                    })
                  : isLinkMode && user?.phone_number
                    ? t("homepage_eliza.getStarted.discordCbConnecting", {
                        defaultValue: "Connecting Discord...",
                      })
                    : t("homepage_eliza.getStarted.discordCbConnected", {
                        defaultValue: "Discord Connected",
                      })}
              </h1>
              <p className="text-sm text-neutral-500 text-center mb-8">
                {discordError
                  ? t("homepage_eliza.getStarted.discordCbSubFailed", {
                      defaultValue:
                        "There was a problem connecting your Discord account",
                    })
                  : isLinkMode && user?.phone_number
                    ? t("homepage_eliza.getStarted.discordCbSubLinking", {
                        defaultValue: "Linking your Discord account...",
                      })
                    : t("homepage_eliza.getStarted.discordCbSubAddPhone", {
                        defaultValue:
                          "Add your phone number to link iMessage, or skip this step",
                      })}
              </p>

              {discordError && (
                <div className="w-full mb-4 p-3 rounded-2xl bg-red-50/80 border border-red-200">
                  <p className="text-sm text-red-600 text-center">
                    {discordError}
                  </p>
                </div>
              )}

              {discordError ? (
                <>
                  <Button
                    onClick={() => handleMethodSelect("discord")}
                    className="w-full h-[52px] rounded-full bg-neutral-900 text-white font-medium hover:bg-neutral-800"
                  >
                    {t("homepage_eliza.getStarted.tryAgain", {
                      defaultValue: "Try Again",
                    })}
                  </Button>
                  <button
                    type="button"
                    onClick={handleBack}
                    className="w-full mt-4 text-sm text-neutral-500 hover:text-neutral-700 cursor-pointer"
                  >
                    {t("homepage_eliza.getStarted.chooseDifferent", {
                      defaultValue: "Choose a different method",
                    })}
                  </button>
                </>
              ) : isLinkMode && user?.phone_number ? (
                <div className="w-full flex flex-col items-center gap-3">
                  <div className="text-neutral-500 animate-pulse text-sm">
                    {t("homepage_eliza.getStarted.settingUp", {
                      defaultValue: "Setting up...",
                    })}
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
                      variant="glass"
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
                    className={`w-full h-[52px] rounded-full font-medium transition-colors ${
                      hasPhoneNumber
                        ? "bg-neutral-900 text-white hover:bg-neutral-800"
                        : "bg-white/40 border border-white/60 text-neutral-400 cursor-not-allowed"
                    }`}
                  >
                    {isSubmittingPhone || isDiscordLoading
                      ? t("homepage_eliza.getStarted.settingUp", {
                          defaultValue: "Setting up...",
                        })
                      : t("homepage_eliza.getStarted.continueWithPhone", {
                          defaultValue: "Continue with Phone",
                        })}
                  </Button>

                  <button
                    type="button"
                    onClick={handleDiscordSkipPhone}
                    disabled={isDiscordLoading}
                    className="w-full mt-4 text-sm text-neutral-500 hover:text-neutral-700 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                  >
                    {isDiscordLoading
                      ? t("homepage_eliza.getStarted.settingUp", {
                          defaultValue: "Setting up...",
                        })
                      : t("homepage_eliza.getStarted.skipAddLater", {
                          defaultValue: "Skip — I’ll add it later",
                        })}
                  </button>

                  <p className="text-xs text-neutral-400 text-center mt-4">
                    {t("homepage_eliza.getStarted.phoneHelper", {
                      defaultValue:
                        "Phone number enables cross-platform chat via iMessage",
                    })}
                  </p>
                </>
              )}
            </>
          )}

          {step === "DISCORD_SETUP_GUIDE" && (
            <>
              {guideParam ? (
                <>
                  <div
                    className={`w-16 h-16 rounded-full ${GLASS_TILE} flex items-center justify-center mb-6`}
                  >
                    <Info className="size-8 text-[#5865F2]" />
                  </div>
                  <h1 className="text-xl font-semibold tracking-tight text-neutral-900 text-center mb-2">
                    {t("homepage_eliza.getStarted.guideTitleGuide", {
                      defaultValue: "Discord Setup Guide",
                    })}
                  </h1>
                </>
              ) : (
                <>
                  <div
                    className={`w-16 h-16 rounded-full ${GLASS_TILE} flex items-center justify-center mb-6`}
                  >
                    <Check className="size-8 text-[#5865F2]" />
                  </div>
                  <h1 className="text-xl font-semibold tracking-tight text-neutral-900 text-center mb-2">
                    {t("homepage_eliza.getStarted.guideTitleAllSet", {
                      defaultValue: "You’re all set!",
                    })}
                  </h1>
                </>
              )}
              <div className="w-full flex flex-col gap-4">
                <div className={`w-full p-4 ${GLASS_TILE} rounded-2xl`}>
                  <div className="flex items-start gap-3">
                    <div className="w-7 h-7 rounded-full bg-white/60 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-xs font-semibold text-neutral-700">
                        1
                      </span>
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-neutral-900">
                        {t("homepage_eliza.getStarted.guideStep1", {
                          defaultValue: "Add Eliza to your server",
                        })}
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
                        className="mt-3 rounded-full border-neutral-300 bg-white/50 text-neutral-800 hover:bg-neutral-900 hover:text-white gap-1.5"
                      >
                        <ExternalLink className="size-3.5" />
                        {t("homepage_eliza.getStarted.guideInviteToServer", {
                          defaultValue: "Invite to Server",
                        })}
                      </Button>
                    </div>
                  </div>
                </div>

                <div className={`w-full p-4 ${GLASS_TILE} rounded-2xl`}>
                  <div className="flex items-start gap-3">
                    <div className="w-7 h-7 rounded-full bg-white/60 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-xs font-semibold text-neutral-700">
                        2
                      </span>
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-neutral-900">
                        {t("homepage_eliza.getStarted.guideStep2", {
                          defaultValue: "Send a direct message",
                        })}
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
                        className="mt-3 rounded-full border-neutral-300 bg-white/50 text-neutral-800 hover:bg-neutral-900 hover:text-white gap-1.5"
                      >
                        <ExternalLink className="size-3.5" />
                        {t("homepage_eliza.getStarted.guideOpenDm", {
                          defaultValue: "Open DM",
                        })}
                      </Button>
                    </div>
                  </div>
                </div>

                <div className={`w-full p-4 ${GLASS_TILE} rounded-2xl`}>
                  <div className="flex items-start gap-3">
                    <div className="w-7 h-7 rounded-full bg-white/60 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-xs font-semibold text-neutral-700">
                        3
                      </span>
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-neutral-900">
                        {t("homepage_eliza.getStarted.guideStep3", {
                          defaultValue: "Start chatting",
                        })}
                      </p>
                      <div className="mt-2 px-3 py-2 bg-white/50 border border-white/60 rounded-xl">
                        <p className="text-sm text-neutral-700 font-medium">
                          {t("homepage_eliza.getStarted.guideSampleQuote", {
                            defaultValue: '"Hey Eliza, what can you do?"',
                          })}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <Button
                onClick={handleContinueToConnected}
                className="w-full h-[52px] rounded-full bg-neutral-900 hover:bg-neutral-800 text-white font-medium mt-6"
              >
                {t("homepage_eliza.getStarted.guideContinue", {
                  defaultValue: "Continue",
                })}
              </Button>
            </>
          )}
        </div>
      </div>

      <footer className="relative z-10 p-4 text-center">
        <p className="text-[11px] font-medium tracking-wide text-neutral-600">
          {t("homepage_eliza.common.year", {
            defaultValue: "ElizaCloud Inc. {{year}}",
            year: new Date().getFullYear(),
          })}
        </p>
      </footer>
    </main>
  );
}
