/** Preserves the public pairing-service import path over the canonical implementation. */

export {
  sanitizeAccountId,
  type WhatsAppPairingEvent,
  type WhatsAppPairingOptions,
  WhatsAppPairingSession,
  type WhatsAppPairingStatus,
  whatsappAuthExists,
  whatsappLogout,
} from "./services/whatsapp-pairing.js";
