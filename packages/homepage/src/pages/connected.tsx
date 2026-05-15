import { Check, Copy, Info, LogOut } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
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

function getTelegramBotUsername(): string {
  return import.meta.env.VITE_TELEGRAM_BOT_USERNAME || "ElizaCloudBot";
}

function getDiscordBotApplicationId(): string {
  return (import.meta.env.VITE_DISCORD_CLIENT_ID || "").trim();
}

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

  const [showPhoneInput, setShowPhoneInput] = useState(false);
  const [selectedCountry, setSelectedCountry] = useState<string>("US");
  const [phoneValue, setPhoneValue] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [isLinkingPhone, setIsLinkingPhone] = useState(false);

  const countryOptions = useCountryOptions();

  const getFullPhoneNumber = useCallback(() => {
    return buildFullPhoneNumber(phoneValue, selectedCountry, countryOptions);
  }, [phoneValue, selectedCountry, countryOptions]);

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

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate("/login", { replace: true });
    }
  }, [isAuthenticated, isLoading, navigate]);

  const handleCopyPhone = async () => {
    await navigator.clipboard.writeText(ELIZA_PHONE_NUMBER);
    setCopiedPhone(true);
    setTimeout(() => setCopiedPhone(false), 2000);
  };

  const handleCopyTelegram = async () => {
    await navigator.clipboard.writeText(
      `https://t.me/${getTelegramBotUsername()}`,
    );
    setCopiedTelegram(true);
    setTimeout(() => setCopiedTelegram(false), 2000);
  };

  const handleCopyWhatsApp = async () => {
    const waNumber = getWhatsAppNumber().replace(/\D/g, "");
    await navigator.clipboard.writeText(`https://wa.me/${waNumber}`);
    setCopiedWhatsApp(true);
    setTimeout(() => setCopiedWhatsApp(false), 2000);
  };

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const handleOpenTelegram = () => {
    window.open(`https://t.me/${getTelegramBotUsername()}`, "_blank");
  };

  const handleOpenDiscord = () => {
    const appId = getDiscordBotApplicationId();
    window.open(`https://discord.com/users/${appId}`, "_blank");
  };

  const handleOpenWhatsApp = () => {
    const waNumber = getWhatsAppNumber().replace(/\D/g, "");
    window.open(`https://wa.me/${waNumber}`, "_blank");
  };

  const handleOpenMessages = () => {
    window.location.href = buildElizaSmsHref();
  };

  if (isLoading) {
    return (
      <main className="min-h-screen bg-[#0d0d0f] flex flex-col items-center justify-center px-4">
        <div className="text-white/60 animate-pulse">Loading...</div>
      </main>
    );
  }

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

  const rawCreditBalance = organization?.credit_balance || "0.00";
  const creditBalance = Number(rawCreditBalance).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return (
    <main className="min-h-screen bg-[#0d0d0f] flex flex-col items-center justify-center px-4 relative">
      <div className="absolute top-4 right-4 flex items-center gap-3">
        <div className="backdrop-blur-xl bg-white/5 border border-white/10 rounded-2xl px-4 py-2.5 flex items-center gap-2">
          <span className="text-xs text-white/50">Credits</span>
          <span className="text-sm font-semibold text-white">
            ${creditBalance}
          </span>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="focus:outline-none focus:ring-2 focus:ring-white/20 rounded-full"
            >
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

        <div className="text-center space-y-3">
          <h1 className="text-xl font-medium text-white">Talk to Eliza</h1>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-500/10 border border-green-500/20">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-xs font-medium text-green-400">Awake</span>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          {user.telegram_id ? (
            <div className="w-full h-[72px] rounded-2xl bg-[#229ED9]/10 hover:bg-[#229ED9]/20 text-white border border-[#229ED9]/30 flex items-center px-5 transition-colors">
              <button
                type="button"
                onClick={handleOpenTelegram}
                className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-4 border-0 bg-transparent p-0 text-left text-white"
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
              </button>
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

          {user.phone_number ? (
            <div className="w-full h-[72px] rounded-2xl bg-[#34C759]/10 hover:bg-[#34C759]/20 text-white border border-[#34C759]/30 flex items-center px-5 transition-colors">
              <button
                type="button"
                onClick={handleOpenMessages}
                className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-4 border-0 bg-transparent p-0 text-left text-white"
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
              </button>
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
              <button
                type="button"
                className="w-full h-[72px] rounded-2xl bg-[#34C759]/10 hover:bg-[#34C759]/20 text-white border border-[#34C759]/30 flex items-center gap-4 px-5 cursor-pointer transition-colors"
                onClick={() => setShowPhoneInput((v) => !v)}
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
              </button>

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

          {user.whatsapp_id ? (
            <div className="w-full h-[72px] rounded-2xl bg-[#25D366]/10 hover:bg-[#25D366]/20 text-white border border-[#25D366]/30 flex items-center px-5 transition-colors">
              <button
                type="button"
                onClick={handleOpenWhatsApp}
                className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-4 border-0 bg-transparent p-0 text-left text-white"
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
              </button>
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
            <button
              type="button"
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
            </button>
          )}

          {user.discord_id ? (
            <div className="w-full h-[72px] rounded-2xl bg-[#5865F2]/10 hover:bg-[#5865F2]/20 text-white border border-[#5865F2]/30 flex items-center px-5 transition-colors">
              <button
                type="button"
                onClick={handleOpenDiscord}
                className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-4 border-0 bg-transparent p-0 text-left text-white"
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
              </button>
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
