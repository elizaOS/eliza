/**
 * Contact constants and link builders for homepage messaging entrypoints.
 */
export const ELIZA_PHONE_NUMBER = "+18087881821";
export const ELIZA_TELEGRAM_BOT_USERNAME = "Elizav2_Bot";
export const ELIZA_TELEGRAM_BOT_ID = "7684336618";
export const ELIZA_DISCORD_APPLICATION_ID = "1468649258654630063";
const DEFAULT_WHATSAPP_PHONE_NUMBER = "+14159611510";
const IMESSAGE_GREETING = "Hey Eliza, what can you do?";

interface MessageNavigator {
  clipboard?: Pick<Clipboard, "writeText">;
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}

interface MessageWindow {
  location: Pick<Location, "href">;
  navigator: MessageNavigator;
}

function normalizeWhatsAppNumber(value: string): string | null {
  const normalized = value.trim();
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}

/** Resolve a deploy-configured E.164 sender without leaking a fixture to production. */
export function resolveWhatsAppNumber(
  configuredValue: string | undefined,
  production: boolean,
): string | null {
  const configured = normalizeWhatsAppNumber(configuredValue ?? "");
  if (configured) return configured;
  return production ? null : DEFAULT_WHATSAPP_PHONE_NUMBER;
}

export function getWhatsAppNumber(): string | null {
  return resolveWhatsAppNumber(
    import.meta.env.VITE_WHATSAPP_PHONE_NUMBER,
    import.meta.env.PROD,
  );
}

export function getTelegramBotUsername(): string {
  return (
    import.meta.env.VITE_TELEGRAM_BOT_USERNAME || ELIZA_TELEGRAM_BOT_USERNAME
  ).trim();
}

export function getTelegramBotId(): string {
  return (import.meta.env.VITE_TELEGRAM_BOT_ID || ELIZA_TELEGRAM_BOT_ID).trim();
}

export function getDiscordBotApplicationId(): string {
  return (
    import.meta.env.VITE_DISCORD_CLIENT_ID || ELIZA_DISCORD_APPLICATION_ID
  ).trim();
}

export function buildElizaSmsHref(message: string = IMESSAGE_GREETING): string {
  return `sms:${ELIZA_PHONE_NUMBER}?&body=${encodeURIComponent(message)}`;
}

/** Whether this browser runs on a platform with a dependable native SMS handler. */
export function canOpenElizaSmsLink(navigatorValue: MessageNavigator): boolean {
  const platform =
    navigatorValue.userAgentData?.platform ?? navigatorValue.platform ?? "";
  const browserIdentity = `${platform} ${navigatorValue.userAgent ?? ""}`;
  return /Android|iPhone|iPad|iPod|Mac/i.test(browserIdentity);
}

/** Open Messages where supported, otherwise copy the sender for manual use. */
export async function openOrCopyElizaMessage(
  windowValue: MessageWindow,
  message: string = IMESSAGE_GREETING,
): Promise<"opened" | "copied"> {
  if (canOpenElizaSmsLink(windowValue.navigator)) {
    windowValue.location.href = buildElizaSmsHref(message);
    return "opened";
  }

  if (!windowValue.navigator.clipboard) {
    throw new Error("Clipboard access is unavailable");
  }
  await windowValue.navigator.clipboard.writeText(ELIZA_PHONE_NUMBER);
  return "copied";
}

export function buildElizaWhatsAppHref(): string | null {
  const number = getWhatsAppNumber();
  return number ? `https://wa.me/${number.replace(/\D/g, "")}` : null;
}

export function buildElizaTelegramHref(): string {
  return `https://t.me/${getTelegramBotUsername()}`;
}

export function buildElizaDiscordHref(): string {
  return `https://discord.com/users/${getDiscordBotApplicationId()}`;
}
