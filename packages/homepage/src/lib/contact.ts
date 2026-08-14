/**
 * Contact constants and link builders for homepage messaging entrypoints.
 */
export const ELIZA_PHONE_NUMBER = "+18087881821";
export const ELIZA_PHONE_FORMATTED = "+1 (808) 788-1821";
export const ELIZA_TELEGRAM_BOT_USERNAME = "Elizav2_Bot";
export const ELIZA_TELEGRAM_BOT_ID = "7684336618";
export const ELIZA_DISCORD_APPLICATION_ID = "1468649258654630063";
const DEFAULT_WHATSAPP_PHONE_NUMBER = "+14159611510";
const IMESSAGE_GREETING = "Hey Eliza, what can you do?";

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

export function buildElizaWhatsAppHref(): string | null {
  const number = getWhatsAppNumber();
  return number ? `https://wa.me/${number.replace(/\D/g, "")}` : null;
}

export function buildElizaTelegramHref(): string {
  return `https://t.me/${getTelegramBotUsername()}`;
}

export function buildElizaDiscordHref(): string {
  return `discord://-/users/${getDiscordBotApplicationId()}`;
}
