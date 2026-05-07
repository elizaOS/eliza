import type { Plugin } from "@elizaos/core";
import { messageOpAction } from "./actions";
import { WhatsAppN8nCredentialProvider } from "./n8n-credential-provider";
import { WhatsAppConnectorService } from "./runtime-service";
import { whatsappSetupRoutes } from "./setup-routes";

const whatsappPlugin: Plugin = {
  name: "whatsapp",
  description: "WhatsApp integration for ElizaOS (Cloud API + Baileys)",
  actions: [messageOpAction],
  services: [WhatsAppConnectorService, WhatsAppN8nCredentialProvider],
  routes: whatsappSetupRoutes,
};

export default whatsappPlugin;

// Account management exports
export {
  checkWhatsAppUserAccess,
  DEFAULT_ACCOUNT_ID,
  isMultiAccountEnabled,
  isWhatsAppMentionRequired,
  isWhatsAppUserAllowed,
  listEnabledWhatsAppAccounts,
  listWhatsAppAccountIds,
  normalizeAccountId,
  type ResolvedWhatsAppAccount,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
  resolveWhatsAppGroupConfig,
  resolveWhatsAppToken,
  type WhatsAppAccessCheckResult,
  type WhatsAppAccountRuntimeConfig,
  type WhatsAppGroupRuntimeConfig,
  type WhatsAppMultiAccountConfig,
  type WhatsAppTokenResolution,
  type WhatsAppTokenSource,
} from "./accounts";
export { ClientFactory } from "./clients/factory";
// Channel configuration types
export type {
  WhatsAppAccountConfig,
  WhatsAppAckReactionConfig,
  WhatsAppActionConfig,
  WhatsAppChannelConfig,
  WhatsAppGroupConfig,
} from "./config";
// Normalization and utility exports
export {
  buildWhatsAppUserJid,
  type ChunkWhatsAppTextOpts,
  chunkWhatsAppText,
  formatWhatsAppId,
  formatWhatsAppPhoneNumber,
  getWhatsAppChatType,
  isValidWhatsAppNumber,
  isWhatsAppGroup,
  isWhatsAppGroupJid,
  isWhatsAppUserTarget,
  normalizeE164,
  normalizeWhatsAppTarget,
  resolveWhatsAppSystemLocation,
  truncateText,
  WHATSAPP_TEXT_CHUNK_LIMIT,
} from "./normalize";
export {
  sanitizeAccountId as sanitizeWhatsAppAccountId,
  type WhatsAppPairingEvent,
  type WhatsAppPairingOptions,
  WhatsAppPairingSession,
  type WhatsAppPairingStatus,
  whatsappAuthExists,
  whatsappLogout,
} from "./pairing-service";
export { WhatsAppConnectorService } from "./runtime-service";
export { stopAllPairingSessions, whatsappSetupRoutes } from "./setup-routes";
export * from "./types";
