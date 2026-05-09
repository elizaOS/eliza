import { Check, Copy, Info, LogOut } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  buildFullPhoneNumber,
  PhoneNumberInput,
  useCountryOptions,
} from "@/components/login/phone-number-input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  buildElizaSmsHref,
  ELIZA_PHONE_FORMATTED,
  ELIZA_PHONE_NUMBER,
  getWhatsAppNumber,
} from "@/lib/contact";
import { useAuth } from "@/lib/context/auth-context";

/**
 * Telegram bot username for direct link
 */
function getTelegramBotUsername(): string {
  return import.meta.env.VITE_TELEGRAM_BOT_USERNAME || "ElizaCloudBot";
}

function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <title>Telegram</title>
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
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

function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <title>WhatsApp</title>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <title>Discord</title>
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

function getDiscordBotApplicationId(): string {
  return (import.meta.env.VITE_DISCORD_CLIENT_ID || "").trim();
}

/**
 * Displays a note about cross-platform conversation linking,
 * only when the user has 2+ platforms connected.
 */
function CrossPlatformNote({
  telegramId,
  discordId,
  whatsappId,
  phoneNumber,
}: {
  telegramId?: string | null;
  discordId?: string | null;
  whatsappId?: string | null;
  phoneNumber?: string | null;
}) {
  const platforms: string[] = [];
  if (telegramId) platforms.push("Telegram");
  if (whatsappId) platforms.push("WhatsApp");
  if (discordId) platforms.push("Discord");
  if (phoneNumber) platforms.push("iMessage");

  if (platforms.length < 2) return null;

  let text: string;
  if (platforms.length === 2) {
    text = `Your conversations are linked across ${platforms[0]} and ${platforms[1]}`;
  } else if (platforms.length === 3) {
    text = `Your conversations are linked across ${platforms[0]}, ${platforms[1]}, and ${platforms[2]}`;
  } else {
    text = `Your conversations are linked across ${platforms.slice(0, -1).join(", ")}, and ${platforms[platforms.length - 1]}`;
  }

  return <p className="text-xs text-white/40 text-center">{text}</p>;
}

export default function ConnectedPage() {
  const navigate = useNavigate();
  const { user, organization, isAuthenticated, isLoading, logout, linkPhone } =
    useAuth();
  const [copiedPhone, setCopiedPhone] = useState(false);
  const [copiedTelegram, setCopiedTelegram] = useState(false);
  const [copiedWhatsApp, setCopiedWhatsApp] = useState(false);

  // Phone linking state
  const [showPhoneInput, setShowPhoneInput] = useState(false);
  const [selectedCountry, setSelectedCountry] = useState<string>("US");
  const [phoneValue, setPhoneValue] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [isLinkingPhone, setIsLinkingPhone] = useState(false);

  const countryOptions = useCountryOptions();

  const getFullPhoneNumber = useCallback(() => {
    return buildFullPhoneNumber(phoneValue, selectedCountry, countryOptions);
  }, [phoneValue, selectedCountry, countryOptions]);

  const handleActivationKey = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, action: () => void) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        action();
      }
    },
    [],
  );

  const handleLinkPhone = useCallback(async () => {
    if (!phoneValue.trim()) return;

    setIsLinkingPhone(true);
    setPhoneError(null);

    const fullPhone = getFullPhoneNumber();
    const result = await linkPhone(fullPhone);

    if (result.success) {
      setShowPhoneInput(false);
      setPhoneValue("");
    } else {
      // Show user-friendly messages based on error code
      if (result.errorCode === "PHONE_ALREADY_LINKED") {
        setPhoneError(
          "This phone number is already linked to another account. Please use a different number.",
        );
      } else if (result.errorCode === "PHONE_ALREADY_SET") {
        setPhoneError("A phone number is already linked to your account.");
      } else if (result.errorCode === "INVALID_REQUEST") {
        setPhoneError(
          "Invalid phone number format. Please check and try again.",
        );
      } else {
        setPhoneError(
          result.error || "Something went wrong. Please try again.",
        );
      }
    }

    setIsLinkingPhone(false);
  }, [phoneValue, getFullPhoneNumber, linkPhone]);

  /**
   * Redirect to login if not authenticated
   */
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate("/login", { replace: true });
    }
  }, [isAuthenticated, isLoading, navigate]);

  /**
   * Copy phone number to clipboard
   */
  const handleCopyPhone = async () => {
    await navigator.clipboard.writeText(ELIZA_PHONE_NUMBER);
    setCopiedPhone(true);
    setTimeout(() => setCopiedPhone(false), 2000);
  };

  /**
   * Copy Telegram bot link to clipboard
   */
  const handleCopyTelegram = async () => {
    await navigator.clipboard.writeText(
      `https://t.me/${getTelegramBotUsername()}`,
    );
    setCopiedTelegram(true);
    setTimeout(() => setCopiedTelegram(false), 2000);
  };

  /**
   * Copy WhatsApp chat link to clipboard
   */
  const handleCopyWhatsApp = async () => {
    const waNumber = getWhatsAppNumber().replace(/\D/g, "");
    await navigator.clipboard.writeText(`https://wa.me/${waNumber}`);
    setCopiedWhatsApp(true);
    setTimeout(() => setCopiedWhatsApp(false), 2000);
  };

  /**
   * Handle logout
   */
  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  /**
   * Open Telegram bot chat
   */
  const handleOpenTelegram = () => {
    window.open(`https://t.me/${getTelegramBotUsername()}`, "_blank");
  };

  /**
   * Open Discord DM with bot
   */
  const handleOpenDiscord = () => {
    const appId = getDiscordBotApplicationId();
    window.open(`https://discord.com/users/${appId}`, "_blank");
  };

  /**
   * Open WhatsApp chat with bot
   */
  const handleOpenWhatsApp = () => {
    const waNumber = getWhatsAppNumber().replace(/\D/g, "");
    window.open(`https://wa.me/${waNumber}`, "_blank");
  };

  /**
   * Open iMessage with pre-populated greeting
   */
  const handleOpenMessages = () => {
    window.location.href = buildElizaSmsHref();
  };

  // Show loading while checking auth state
  if (isLoading) {
    return (
      <main className="min-h-screen bg-[#0d0d0f] flex flex-col items-center justify-center px-4">
        <div className="text-white/60 animate-pulse">Loading...</div>
      </main>
    );
  }

  // Don't render if not authenticated (will redirect)
  if (!isAuthenticated || !user) {
    return (
      <main className="min-h-screen bg-[#0d0d0f] flex flex-col items-center justify-center px-4">
        <div className="text-white/60 animate-pulse">Redirecting...</div>
      </main>
    );
  }

  const displayName =
    user.name ||
    user.telegram_first_name ||
    user.telegram_username ||
    user.discord_global_name ||
    user.discord_username ||
    "User";

  // Format credit balance with commas for thousands
  const rawCreditBalance = organization?.credit_balance || "0.00";
  const creditBalance = Number(rawCreditBalance).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return (
    <main className="min-h-screen bg-[#0d0d0f] flex flex-col items-center justify-center px-4 relative">
      {/* Top right header - Credits and User profile with dropdown */}
      <div className="absolute top-4 right-4 flex items-center gap-3">
        <div className="backdrop-blur-xl bg-white/5 border border-white/10 rounded-2xl px-4 py-2.5 flex items-center gap-2">
          <span className="text-xs text-white/50">Credits</span>
          <span className="text-sm font-semibold text-white">
            ${creditBalance}
          </span>
        </div>

        {/* User profile with dropdown menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="focus:outline-none focus:ring-2 focus:ring-white/20 rounded-full">
              {user.avatar ? (
                <img
                  src={user.avatar}
                  alt={displayName}
                  width={36}
                  height={36}
                  className="rounded-full cursor-pointer hover:ring-2 hover:ring-white/20 transition-all"
                />
              ) : (
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center text-white text-sm font-semibold cursor-pointer hover:ring-2 hover:ring-white/20 transition-all">
                  {displayName.charAt(0).toUpperCase()}
                </div>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-48 bg-[#1a1a1c] border-white/10 text-white"
          >
            <div className="px-2 py-2 border-b border-white/10">
              <p className="text-sm font-medium">{displayName}</p>
              {user.telegram_username && (
                <p className="text-xs text-white/50">
                  @{user.telegram_username}
                </p>
              )}
              {user.discord_username && !user.telegram_username && (
                <p className="text-xs text-white/50">
                  @{user.discord_username}
                </p>
              )}
            </div>
            <DropdownMenuItem
              onClick={handleLogout}
              className="text-red-400 hover:text-red-300 hover:bg-red-500/10 focus:bg-red-500/10 focus:text-red-300 cursor-pointer mt-1"
            >
              <LogOut className="size-4 mr-2" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="w-full max-w-[440px] flex flex-col gap-8">
        {/* Eliza profile image */}
        <div className="flex flex-col items-center">
          <img
            src="/eliza-app-profile-image.png"
            alt="Eliza"
            width={145}
            height={145}
            className="rounded-full select-none pointer-events-none"
            draggable={false}
          />
        </div>

        {/* Title and Connected status */}
        <div className="text-center space-y-3">
          <h1 className="text-xl font-medium text-white">Talk to Eliza</h1>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-500/10 border border-green-500/20">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-xs font-medium text-green-400">Awake</span>
          </div>
        </div>

        {/* Chat options */}
        <div className="flex flex-col gap-4">
          {/* Telegram option - different states based on whether connected */}
          {user.telegram_id ? (
            <div
              className="w-full h-[72px] rounded-2xl bg-[#229ED9]/10 hover:bg-[#229ED9]/20 text-white border border-[#229ED9]/30 flex items-center gap-4 px-5 cursor-pointer transition-colors"
              onClick={handleOpenTelegram}
              onKeyDown={(event) =>
                handleActivationKey(event, handleOpenTelegram)
              }
              role="button"
              tabIndex={0}
            >
              <div className="w-8 h-8 shrink-0 flex items-center justify-center">
                <TelegramIcon className="size-8 text-[#229ED9]" />
              </div>
              <div className="flex flex-col items-start flex-1">
                <span className="text-lg font-medium">Telegram</span>
                <span className="text-sm text-white/50">
                  @{getTelegramBotUsername()}
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCopyTelegram();
                }}
                className="shrink-0 text-white/40 hover:text-white hover:bg-white/10"
                title="Copy Telegram link"
              >
                {copiedTelegram ? (
                  <Check className="size-5 text-green-400" />
                ) : (
                  <Copy className="size-5" />
                )}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              onClick={() => navigate("/get-started?method=telegram&link=true")}
              className="w-full h-[72px] rounded-2xl bg-[#229ED9]/10 hover:bg-[#229ED9]/20 text-white border border-[#229ED9]/30 gap-4 justify-start px-5"
            >
              <div className="w-8 h-8 shrink-0 flex items-center justify-center">
                <TelegramIcon className="size-8 text-[#229ED9]" />
              </div>
              <div className="flex flex-col items-start">
                <span className="text-lg font-medium">Connect Telegram</span>
                <span className="text-sm text-white/50">
                  Link your Telegram account
                </span>
              </div>
            </Button>
          )}

          {/* iMessage option - different states based on whether phone is linked */}
          {user.phone_number ? (
            <div
              className="w-full h-[72px] rounded-2xl bg-[#34C759]/10 hover:bg-[#34C759]/20 text-white border border-[#34C759]/30 flex items-center gap-4 px-5 cursor-pointer transition-colors"
              onClick={handleOpenMessages}
              onKeyDown={(event) =>
                handleActivationKey(event, handleOpenMessages)
              }
              role="button"
              tabIndex={0}
            >
              <div className="w-8 h-8 shrink-0 flex items-center justify-center">
                <AppleMessagesIcon className="size-8" />
              </div>
              <div className="flex flex-col items-start flex-1">
                <span className="text-lg font-medium">iMessage</span>
                <span className="text-sm text-white/50">
                  {ELIZA_PHONE_FORMATTED}
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCopyPhone();
                }}
                className="shrink-0 text-white/40 hover:text-white hover:bg-white/10"
                title="Copy number"
              >
                {copiedPhone ? (
                  <Check className="size-5 text-green-400" />
                ) : (
                  <Copy className="size-5" />
                )}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div
                className="w-full h-[72px] rounded-2xl bg-[#34C759]/10 hover:bg-[#34C759]/20 text-white border border-[#34C759]/30 flex items-center gap-4 px-5 cursor-pointer transition-colors"
                onClick={() => setShowPhoneInput((v) => !v)}
                onKeyDown={(event) =>
                  handleActivationKey(event, () =>
                    setShowPhoneInput((v) => !v),
                  )
                }
                role="button"
                tabIndex={0}
              >
                <div className="w-8 h-8 shrink-0 flex items-center justify-center">
                  <AppleMessagesIcon className="size-8" />
                </div>
                <div className="flex flex-col items-start flex-1">
                  <span className="text-lg font-medium">iMessage</span>
                  <span className="text-sm text-white/50">
                    Add your phone number to enable
                  </span>
                </div>
              </div>

              {/* Inline phone input form */}
              {showPhoneInput && (
                <div className="w-full rounded-2xl bg-white/5 border border-white/10 p-4 flex flex-col gap-3">
                  <p className="text-xs text-white/50">
                    Link your phone to chat with Eliza via iMessage
                  </p>
                  <PhoneNumberInput
                    selectedCountry={selectedCountry}
                    onCountryChange={setSelectedCountry}
                    phoneValue={phoneValue}
                    onPhoneChange={setPhoneValue}
                    onSubmit={handleLinkPhone}
                    variant="dark"
                    autoFocus
                    countryOptions={countryOptions}
                  />
                  {phoneError && (
                    <p className="text-xs text-red-400">{phoneError}</p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      onClick={handleLinkPhone}
                      disabled={!phoneValue.trim() || isLinkingPhone}
                      className="flex-1 h-10 rounded-xl bg-[#34C759] hover:bg-[#2DB84D] text-white text-sm font-medium disabled:opacity-50"
                    >
                      {isLinkingPhone ? "Linking..." : "Link Phone"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setShowPhoneInput(false);
                        setPhoneError(null);
                        setPhoneValue("");
                      }}
                      className="h-10 rounded-xl text-white/40 hover:text-white hover:bg-white/10 text-sm"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* WhatsApp option - different states based on whether connected */}
          {user.whatsapp_id ? (
            <div
              className="w-full h-[72px] rounded-2xl bg-[#25D366]/10 hover:bg-[#25D366]/20 text-white border border-[#25D366]/30 flex items-center gap-4 px-5 cursor-pointer transition-colors"
              onClick={handleOpenWhatsApp}
            >
              <div className="w-8 h-8 shrink-0 flex items-center justify-center">
                <WhatsAppIcon className="size-8 text-[#25D366]" />
              </div>
              <div className="flex flex-col items-start flex-1">
                <span className="text-lg font-medium">WhatsApp</span>
                <span className="text-sm text-white/50">
                  {user.whatsapp_name || "Open WhatsApp"}
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCopyWhatsApp();
                }}
                className="shrink-0 text-white/40 hover:text-white hover:bg-white/10"
                title="Copy WhatsApp link"
              >
                {copiedWhatsApp ? (
                  <Check className="size-5 text-green-400" />
                ) : (
                  <Copy className="size-5" />
                )}
              </Button>
            </div>
          ) : (
            <div
              className="w-full h-[72px] rounded-2xl bg-[#25D366]/10 hover:bg-[#25D366]/20 text-white border border-[#25D366]/30 flex items-center gap-4 px-5 cursor-pointer transition-colors"
              onClick={handleOpenWhatsApp}
            >
              <div className="w-8 h-8 shrink-0 flex items-center justify-center">
                <WhatsAppIcon className="size-8 text-[#25D366]" />
              </div>
              <div className="flex flex-col items-start flex-1">
                <span className="text-lg font-medium">WhatsApp</span>
                <span className="text-sm text-white/50">
                  Message to connect
                </span>
              </div>
            </div>
          )}

          {/* Discord option - different states based on whether connected */}
          {user.discord_id ? (
            <div
              className="w-full h-[72px] rounded-2xl bg-[#5865F2]/10 hover:bg-[#5865F2]/20 text-white border border-[#5865F2]/30 flex items-center gap-4 px-5 cursor-pointer transition-colors"
              onClick={handleOpenDiscord}
            >
              <div className="w-8 h-8 shrink-0 flex items-center justify-center">
                <DiscordIcon className="size-8 text-[#5865F2]" />
              </div>
              <div className="flex flex-col items-start flex-1">
                <span className="text-lg font-medium">Discord</span>
                <span className="text-sm text-white/50">
                  @{user.discord_username || "Eliza"}
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate("/get-started?guide=discord");
                }}
                className="shrink-0 text-white/40 hover:text-white hover:bg-white/10"
                title="Setup guide"
              >
                <Info className="size-5" />
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              onClick={() => navigate("/get-started?method=discord&link=true")}
              className="w-full h-[72px] rounded-2xl bg-[#5865F2]/10 hover:bg-[#5865F2]/20 text-white border border-[#5865F2]/30 gap-4 justify-start px-5"
            >
              <div className="w-8 h-8 shrink-0 flex items-center justify-center">
                <DiscordIcon className="size-8 text-[#5865F2]" />
              </div>
              <div className="flex flex-col items-start">
                <span className="text-lg font-medium">Connect Discord</span>
                <span className="text-sm text-white/50">
                  Link your Discord account
                </span>
              </div>
            </Button>
          )}

          {/* Note about cross-platform - dynamic based on connected platforms */}
          <CrossPlatformNote
            telegramId={user.telegram_id}
            discordId={user.discord_id}
            whatsappId={user.whatsapp_id}
            phoneNumber={user.phone_number}
          />
        </div>
      </div>

      <footer className="absolute bottom-6 left-0 right-0 text-center">
        <p className="text-[10px] text-white/25">
          ElizaCloud Inc. {new Date().getFullYear()}{" "}
          <a href="/terms" className="hover:text-white/40">
            Terms
          </a>{" "}
          <a href="/privacy" className="hover:text-white/40">
            Privacy
          </a>{" "}
          <a href="/help" className="hover:text-white/40">
            Help
          </a>
        </p>
      </footer>
    </main>
  );
}
