export const ELIZA_PHONE_NUMBER = "+14245074963";
export const ELIZA_PHONE_FORMATTED = "+1 (424) 507-4963";
export const IMESSAGE_GREETING = "Hey Eliza, what can you do?";

export function getWhatsAppNumber(): string {
  return import.meta.env.VITE_WHATSAPP_PHONE_NUMBER || ELIZA_PHONE_NUMBER;
}

export function buildElizaSmsHref(message: string = IMESSAGE_GREETING): string {
  return `sms:${ELIZA_PHONE_NUMBER}&body=${encodeURIComponent(message)}`;
}
