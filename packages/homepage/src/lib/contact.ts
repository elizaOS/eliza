/**
 * Contact constants and link builders for homepage messaging entrypoints.
 */
export const ELIZA_PHONE_NUMBER = "+14159611510";
export const ELIZA_PHONE_FORMATTED = "+1 (415) 961-1510";
export const ELIZA_TELEGRAM_BOT_USERNAME = "Elizav2_Bot";
export const ELIZA_DISCORD_APPLICATION_ID = "1468649258654630063";
const IMESSAGE_GREETING = "Hey Eliza, what can you do?";

export function getWhatsAppNumber(): string {
  return import.meta.env.VITE_WHATSAPP_PHONE_NUMBER || ELIZA_PHONE_NUMBER;
}

export function getTelegramBotUsername(): string {
  return (
    import.meta.env.VITE_TELEGRAM_BOT_USERNAME || ELIZA_TELEGRAM_BOT_USERNAME
  ).trim();
}

export function getDiscordBotApplicationId(): string {
  return (
    import.meta.env.VITE_DISCORD_CLIENT_ID || ELIZA_DISCORD_APPLICATION_ID
  ).trim();
}

export function buildElizaSmsHref(message: string = IMESSAGE_GREETING): string {
  return `sms:${ELIZA_PHONE_NUMBER}?&body=${encodeURIComponent(message)}`;
}

export function buildElizaWhatsAppHref(): string {
  return `https://wa.me/${getWhatsAppNumber().replace(/\D/g, "")}`;
}

export function buildElizaTelegramHref(): string {
  return `https://t.me/${getTelegramBotUsername()}`;
}

export function buildElizaDiscordHref(): string {
  return `https://discord.com/users/${getDiscordBotApplicationId()}`;
}
