import { Button } from "@elizaos/ui/button";
import {
  AppleMessagesIcon,
  DiscordIcon,
  TelegramIcon,
  WhatsAppIcon,
} from "@elizaos/ui/cloud-ui/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@elizaos/ui/dropdown-menu";
import { Check, Copy, Info, LogOut } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  buildFullPhoneNumber,
  PhoneNumberInput,
  useCountryOptions,
} from "@/components/login/phone-number-input";
import {
  buildElizaSmsHref,
  ELIZA_PHONE_FORMATTED,
  ELIZA_PHONE_NUMBER,
  getWhatsAppNumber,
} from "@/lib/contact";
import { useAuth } from "@/lib/context/auth-context";
import { type Translator, useT } from "@/providers/I18nProvider";

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
  t,
}: {
  telegramId?: string | null;
  discordId?: string | null;
  whatsappId?: string | null;
  phoneNumber?: string | null;
  t: Translator;
}) {
  const platforms: string[] = [];
  if (telegramId) platforms.push("Telegram");
  if (whatsappId) platforms.push("WhatsApp");
  if (discordId) platforms.push("Discord");
  if (phoneNumber) platforms.push("iMessage");

  if (platforms.length < 2) return null;

  let text: string;
  if (platforms.length === 2) {
    text = t("homepage_eliza.connected.crossLink2", {
      defaultValue: "Your conversations are linked across {{a}} and {{b}}",
      a: platforms[0],
      b: platforms[1],
    });
  } else if (platforms.length === 3) {
    text = t("homepage_eliza.connected.crossLink3", {
      defaultValue:
        "Your conversations are linked across {{a}}, {{b}}, and {{c}}",
      a: platforms[0],
      b: platforms[1],
      c: platforms[2],
    });
  } else {
    text = t("homepage_eliza.connected.crossLinkMany", {
      defaultValue:
        "Your conversations are linked across {{list}}, and {{last}}",
      list: platforms.slice(0, -1).join(", "),
      last: platforms[platforms.length - 1],
    });
  }

  return <p className="text-xs text-black/55 text-center">{text}</p>;
}

export default function ConnectedPage() {
  const navigate = useNavigate();
  const t = useT();
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
          t("homepage_eliza.connected.errorPhoneAlreadyLinked", {
            defaultValue:
              "This phone number is already linked to another account. Please use a different number.",
          }),
        );
      } else if (result.errorCode === "PHONE_ALREADY_SET") {
        setPhoneError(
          t("homepage_eliza.connected.errorPhoneAlreadySet", {
            defaultValue: "A phone number is already linked to your account.",
          }),
        );
      } else if (result.errorCode === "INVALID_REQUEST") {
        setPhoneError(
          t("homepage_eliza.connected.errorInvalidRequest", {
            defaultValue:
              "Invalid phone number format. Please check and try again.",
          }),
        );
      } else {
        setPhoneError(
          result.error ||
            t("homepage_eliza.connected.errorGeneric", {
              defaultValue: "Something went wrong. Please try again.",
            }),
        );
      }
    }

    setIsLinkingPhone(false);
  }, [phoneValue, getFullPhoneNumber, linkPhone, t]);

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
      <main
        className="theme-app brand-section brand-section--orange min-h-screen flex flex-col items-center justify-center px-4"
        style={{ fontFamily: "Poppins, system-ui, sans-serif" }}
      >
        <div className="text-black/70 animate-pulse font-semibold">
          {t("homepage_eliza.common.loading", { defaultValue: "Loading…" })}
        </div>
      </main>
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <main
        className="theme-app brand-section brand-section--orange min-h-screen flex flex-col items-center justify-center px-4"
        style={{ fontFamily: "Poppins, system-ui, sans-serif" }}
      >
        <div className="text-black/70 animate-pulse font-semibold">
          {t("homepage_eliza.common.redirecting", {
            defaultValue: "Redirecting…",
          })}
        </div>
      </main>
    );
  }

  const displayName =
    user.name ||
    user.telegram_first_name ||
    user.telegram_username ||
    user.discord_global_name ||
    user.discord_username ||
    t("homepage_eliza.connected.userFallback", { defaultValue: "User" });

  const rawCreditBalance = organization?.credit_balance || "0.00";
  const creditBalance = Number(rawCreditBalance).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return (
    <main
      className="theme-app brand-section brand-section--orange min-h-screen flex flex-col items-center justify-center px-4 relative"
      style={{ fontFamily: "Poppins, system-ui, sans-serif" }}
    >
      <div className="absolute top-4 right-4 flex items-center gap-3">
        <div className="bg-black text-white border border-black px-4 py-2.5 flex items-center gap-2">
          <span className="text-xs opacity-60">
            {t("homepage_eliza.connected.credits", { defaultValue: "Credits" })}
          </span>
          <span className="text-sm font-semibold">${creditBalance}</span>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("homepage_eliza.connected.userMenuAria", {
                defaultValue: "Open user menu",
              })}
              className="focus:outline-none focus:ring-2 focus:ring-black focus:ring-offset-2 focus:ring-offset-[color:var(--brand-orange)] rounded-xs"
            >
              {user.avatar ? (
                <img
                  src={user.avatar}
                  alt={displayName}
                  width={36}
                  height={36}
                  className="rounded-xs cursor-pointer hover:ring-2 hover:ring-white/20 transition-all"
                />
              ) : (
                <div className="w-9 h-9 rounded-xs bg-black flex items-center justify-center text-white text-sm font-semibold cursor-pointer hover:ring-2 hover:ring-white/20 transition-all">
                  {displayName.charAt(0).toUpperCase()}
                </div>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-48 bg-black border-white/10 text-white rounded-xs"
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
              {t("homepage_eliza.connected.signOut", {
                defaultValue: "Sign out",
              })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="w-full max-w-[440px] flex flex-col gap-8">
        <div className="flex flex-col items-center">
          <img
            src="/eliza-app-profile-image.png"
            alt={t("homepage_eliza.connected.profileAlt", {
              defaultValue: "Eliza",
            })}
            width={145}
            height={145}
            className="rounded-xs select-none pointer-events-none"
            draggable={false}
          />
        </div>

        <div className="text-center space-y-3">
          <h1
            className="app-display"
            style={{ fontSize: "clamp(2.5rem, 7vw, 4.5rem)" }}
          >
            {t("homepage_eliza.connected.title", {
              defaultValue: "Connected.",
            })}
          </h1>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-black text-white border border-black">
            <span className="w-2 h-2 bg-[var(--brand-orange)] animate-pulse" />
            <span className="text-xs font-semibold">
              {t("homepage_eliza.connected.awake", { defaultValue: "Awake" })}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          {user.telegram_id ? (
            <div className="w-full h-[72px] bg-white hover:bg-white/90 text-black border border-black flex items-center px-5 transition-colors">
              <button
                type="button"
                onClick={handleOpenTelegram}
                className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-4 border-0 bg-transparent p-0 text-left text-black"
              >
                <div className="w-8 h-8 shrink-0 flex items-center justify-center">
                  <TelegramIcon className="size-8 text-[#229ED9]" />
                </div>
                <div className="flex flex-col items-start flex-1">
                  <span className="text-lg font-medium">
                    {t("homepage_eliza.connected.telegramLabel", {
                      defaultValue: "Telegram",
                    })}
                  </span>
                  <span className="text-sm text-black/60">
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
                className="shrink-0 text-black/50 hover:text-black hover:bg-black/5"
                title={t("homepage_eliza.connected.copyTelegramTitle", {
                  defaultValue: "Copy Telegram link",
                })}
                aria-label={t("homepage_eliza.connected.copyTelegramTitle", {
                  defaultValue: "Copy Telegram link",
                })}
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
              className="w-full h-[72px] bg-white hover:bg-white/90 text-black border border-black gap-4 justify-start px-5"
            >
              <div className="w-8 h-8 shrink-0 flex items-center justify-center">
                <TelegramIcon className="size-8 text-[#229ED9]" />
              </div>
              <div className="flex flex-col items-start">
                <span className="text-lg font-medium">
                  {t("homepage_eliza.connected.connectTelegram", {
                    defaultValue: "Connect Telegram",
                  })}
                </span>
              </div>
            </Button>
          )}

          {user.phone_number ? (
            <div className="w-full h-[72px] bg-white hover:bg-white/90 text-black border border-black flex items-center px-5 transition-colors">
              <button
                type="button"
                onClick={handleOpenMessages}
                className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-4 border-0 bg-transparent p-0 text-left text-black"
              >
                <div className="w-8 h-8 shrink-0 flex items-center justify-center">
                  <AppleMessagesIcon className="size-8" />
                </div>
                <div className="flex flex-col items-start flex-1">
                  <span className="text-lg font-medium">
                    {t("homepage_eliza.connected.imessageLabel", {
                      defaultValue: "iMessage",
                    })}
                  </span>
                  <span className="text-sm text-black/60">
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
                className="shrink-0 text-black/50 hover:text-black hover:bg-black/5"
                title={t("homepage_eliza.connected.copyNumberTitle", {
                  defaultValue: "Copy number",
                })}
                aria-label={t("homepage_eliza.connected.copyPhoneAria", {
                  defaultValue: "Copy phone number",
                })}
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
                className="w-full h-[72px] bg-white hover:bg-white/90 text-black border border-black flex items-center gap-4 px-5 cursor-pointer transition-colors"
                onClick={() => setShowPhoneInput((v) => !v)}
              >
                <div className="w-8 h-8 shrink-0 flex items-center justify-center">
                  <AppleMessagesIcon className="size-8" />
                </div>
                <div className="flex flex-col items-start flex-1">
                  <span className="text-lg font-medium">
                    {t("homepage_eliza.connected.imessageLabel", {
                      defaultValue: "iMessage",
                    })}
                  </span>
                </div>
              </button>

              {showPhoneInput && (
                <div className="w-full bg-black text-white border border-black p-4 flex flex-col gap-3">
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
                      className="flex-1 h-10 bg-[var(--brand-orange)] hover:bg-black hover:text-white text-black text-sm font-semibold disabled:opacity-50"
                    >
                      {isLinkingPhone
                        ? t("homepage_eliza.connected.linking", {
                            defaultValue: "Linking...",
                          })
                        : t("homepage_eliza.connected.linkPhone", {
                            defaultValue: "Link Phone",
                          })}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setShowPhoneInput(false);
                        setPhoneError(null);
                        setPhoneValue("");
                      }}
                      className="h-10 text-white/70 hover:text-white hover:bg-white/10 text-sm"
                    >
                      {t("homepage_eliza.connected.cancel", {
                        defaultValue: "Cancel",
                      })}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {user.whatsapp_id ? (
            <div className="w-full h-[72px] bg-white hover:bg-white/90 text-black border border-black flex items-center px-5 transition-colors">
              <button
                type="button"
                onClick={handleOpenWhatsApp}
                className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-4 border-0 bg-transparent p-0 text-left text-black"
              >
                <div className="w-8 h-8 shrink-0 flex items-center justify-center">
                  <WhatsAppIcon className="size-8 text-[#25D366]" />
                </div>
                <div className="flex flex-col items-start flex-1">
                  <span className="text-lg font-medium">
                    {t("homepage_eliza.connected.whatsappLabel", {
                      defaultValue: "WhatsApp",
                    })}
                  </span>
                  <span className="text-sm text-black/60">
                    {user.whatsapp_name ||
                      t("homepage_eliza.connected.openWhatsapp", {
                        defaultValue: "Open WhatsApp",
                      })}
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
                className="shrink-0 text-black/50 hover:text-black hover:bg-black/5"
                title={t("homepage_eliza.connected.copyWhatsappTitle", {
                  defaultValue: "Copy WhatsApp link",
                })}
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
              className="w-full h-[72px] bg-white hover:bg-white/90 text-black border border-black flex items-center gap-4 px-5 cursor-pointer transition-colors"
              onClick={handleOpenWhatsApp}
            >
              <div className="w-8 h-8 shrink-0 flex items-center justify-center">
                <WhatsAppIcon className="size-8 text-[#25D366]" />
              </div>
              <div className="flex flex-col items-start flex-1">
                <span className="text-lg font-medium">
                  {t("homepage_eliza.connected.whatsappLabel", {
                    defaultValue: "WhatsApp",
                  })}
                </span>
              </div>
            </button>
          )}

          {user.discord_id ? (
            <div className="w-full h-[72px] bg-white hover:bg-white/90 text-black border border-black flex items-center px-5 transition-colors">
              <button
                type="button"
                onClick={handleOpenDiscord}
                className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-4 border-0 bg-transparent p-0 text-left text-black"
              >
                <div className="w-8 h-8 shrink-0 flex items-center justify-center">
                  <DiscordIcon className="size-8 text-[#5865F2]" />
                </div>
                <div className="flex flex-col items-start flex-1">
                  <span className="text-lg font-medium">
                    {t("homepage_eliza.connected.discordLabel", {
                      defaultValue: "Discord",
                    })}
                  </span>
                  <span className="text-sm text-black/60">
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
                className="shrink-0 text-black/50 hover:text-black hover:bg-black/5"
                title={t("homepage_eliza.connected.discordSetupGuideTitle", {
                  defaultValue: "Setup guide",
                })}
              >
                <Info className="size-5" />
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              onClick={() => navigate("/get-started?method=discord&link=true")}
              className="w-full h-[72px] bg-white hover:bg-white/90 text-black border border-black gap-4 justify-start px-5"
            >
              <div className="w-8 h-8 shrink-0 flex items-center justify-center">
                <DiscordIcon className="size-8 text-[#5865F2]" />
              </div>
              <div className="flex flex-col items-start">
                <span className="text-lg font-medium">
                  {t("homepage_eliza.connected.connectDiscord", {
                    defaultValue: "Connect Discord",
                  })}
                </span>
              </div>
            </Button>
          )}

          <CrossPlatformNote
            telegramId={user.telegram_id}
            discordId={user.discord_id}
            whatsappId={user.whatsapp_id}
            phoneNumber={user.phone_number}
            t={t}
          />
        </div>
      </div>

      <footer className="absolute bottom-6 left-0 right-0 text-center">
        <p className="text-[10px] text-black/50">
          {t("homepage_eliza.common.year", {
            defaultValue: "ElizaCloud Inc. {{year}}",
            year: new Date().getFullYear(),
          })}{" "}
          <a href="/terms" className="hover:text-black">
            {t("homepage_eliza.common.terms", { defaultValue: "Terms" })}
          </a>{" "}
          <a href="/privacy" className="hover:text-black">
            {t("homepage_eliza.common.privacy", { defaultValue: "Privacy" })}
          </a>{" "}
          <a href="/help" className="hover:text-black">
            {t("homepage_eliza.common.help", { defaultValue: "Help" })}
          </a>
        </p>
      </footer>
    </main>
  );
}
