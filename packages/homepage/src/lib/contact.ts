/**
 * Contact constants and link builders for homepage messaging entrypoints.
 */
export const ELIZA_PHONE_NUMBER = "+18087881821";
export const ELIZA_PHONE_FORMATTED = "+1 (808) 788-1821";
export const ELIZA_TELEGRAM_BOT_USERNAME = "Elizav2_Bot";
export const ELIZA_TELEGRAM_BOT_ID = "7684336618";
export const ELIZA_DISCORD_APPLICATION_ID = "1468649258654630063";
const DEFAULT_WHATSAPP_PHONE_NUMBER = "+14159611510";

export function getWhatsAppNumber(): string {
  return (
    import.meta.env.VITE_WHATSAPP_PHONE_NUMBER || DEFAULT_WHATSAPP_PHONE_NUMBER
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

export function buildElizaSmsHref(): string {
  return `sms:${ELIZA_PHONE_NUMBER}`;
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
