import { getConnectorAccountManager, type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import { createWhatsAppConnectorAccountProvider } from "./connector-account-provider";
import { WhatsAppConnectorService } from "./runtime-service";
import { whatsappSetupRoutes } from "./setup-routes";

const whatsappPlugin: Plugin = {
  name: "whatsapp",
  description: "WhatsApp integration for ElizaOS (Cloud API + Baileys)",
  actions: [],
  services: [WhatsAppConnectorService],
  routes: whatsappSetupRoutes,
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    // Register the WhatsApp provider with the ConnectorAccountManager so the
    // HTTP CRUD surface (packages/agent/src/api/connector-account-routes.ts)
    // can list, create, patch, and delete WhatsApp accounts.
    try {
      const manager = getConnectorAccountManager(runtime);
      manager.registerProvider(createWhatsAppConnectorAccountProvider(runtime));
    } catch (err) {
      logger.warn(
        {
          src: "plugin:whatsapp",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register WhatsApp provider with ConnectorAccountManager"
      );
    }
  },
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
// ConnectorAccountManager provider exports
export {
  createWhatsAppConnectorAccountProvider,
  WHATSAPP_PROVIDER_ID,
} from "./connector-account-provider";
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
