/**
 * Contact constants and link builders for homepage messaging entrypoints.
 */
export const ELIZA_PHONE_NUMBER = "+14159611510";
export const ELIZA_PHONE_FORMATTED = "+1 (415) 961-1510";
const IMESSAGE_GREETING = "Hey Eliza, what can you do?";

export function getWhatsAppNumber(): string {
  return import.meta.env.VITE_WHATSAPP_PHONE_NUMBER || ELIZA_PHONE_NUMBER;
}

export function buildElizaSmsHref(message: string = IMESSAGE_GREETING): string {
  return `sms:${ELIZA_PHONE_NUMBER}?&body=${encodeURIComponent(message)}`;
}
