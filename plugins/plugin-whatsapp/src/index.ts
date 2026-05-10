import { getConnectorAccountManager, type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import { createWhatsAppConnectorAccountProvider } from "./connector-account-provider";
import { WhatsAppConnectorService } from "./runtime-service";
import { whatsappSetupRoutes } from "./setup-routes";
import { WhatsAppWorkflowCredentialProvider } from "./workflow-credential-provider";

const whatsappPlugin: Plugin = {
  name: "whatsapp",
  description: "WhatsApp integration for ElizaOS (Cloud API + Baileys)",
  actions: [],
  services: [WhatsAppConnectorService, WhatsAppWorkflowCredentialProvider],
  routes: whatsappSetupRoutes,
  // Self-declared auto-enable: activate when the "whatsapp" connector is
  // configured under config.connectors. The hardcoded CONNECTOR_PLUGINS map
  // in plugin-auto-enable-engine.ts still serves as a fallback.
  autoEnable: {
    connectorKeys: ["whatsapp"],
  },
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
export {
  applyWhatsAppQrOverride,
  handleWhatsAppRoute,
  MAX_PAIRING_SESSIONS as WHATSAPP_MAX_PAIRING_SESSIONS,
  type WhatsAppPairingEventLike,
  type WhatsAppPairingSessionLike,
  type WhatsAppRouteDeps,
  type WhatsAppRouteState,
} from "./api/whatsapp-routes";
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

// Bundle-safety: force binding identities into the module's init
// function so Bun.build's tree-shake doesn't collapse this barrel
// into an empty `init_X = () => {}`. Without this the on-device
// mobile agent explodes with `ReferenceError: <name> is not defined`
// when a consumer dereferences a re-exported binding at runtime.
import { checkWhatsAppUserAccess as _bs_1_checkWhatsAppUserAccess, DEFAULT_ACCOUNT_ID as _bs_2_DEFAULT_ACCOUNT_ID, isMultiAccountEnabled as _bs_3_isMultiAccountEnabled, isWhatsAppMentionRequired as _bs_4_isWhatsAppMentionRequired, isWhatsAppUserAllowed as _bs_5_isWhatsAppUserAllowed, listEnabledWhatsAppAccounts as _bs_6_listEnabledWhatsAppAccounts, listWhatsAppAccountIds as _bs_7_listWhatsAppAccountIds, normalizeAccountId as _bs_8_normalizeAccountId, resolveDefaultWhatsAppAccountId as _bs_9_resolveDefaultWhatsAppAccountId, resolveWhatsAppAccount as _bs_10_resolveWhatsAppAccount, resolveWhatsAppGroupConfig as _bs_11_resolveWhatsAppGroupConfig, resolveWhatsAppToken as _bs_12_resolveWhatsAppToken } from "./accounts";
import { applyWhatsAppQrOverride as _bs_13_applyWhatsAppQrOverride, handleWhatsAppRoute as _bs_14_handleWhatsAppRoute, MAX_PAIRING_SESSIONS as _bs_15_MAX_PAIRING_SESSIONS } from "./api/whatsapp-routes";
import { ClientFactory as _bs_16_ClientFactory } from "./clients/factory";
import { createWhatsAppConnectorAccountProvider as _bs_17_createWhatsAppConnectorAccountProvider, WHATSAPP_PROVIDER_ID as _bs_18_WHATSAPP_PROVIDER_ID } from "./connector-account-provider";
import { buildWhatsAppUserJid as _bs_19_buildWhatsAppUserJid, chunkWhatsAppText as _bs_20_chunkWhatsAppText, formatWhatsAppId as _bs_21_formatWhatsAppId, formatWhatsAppPhoneNumber as _bs_22_formatWhatsAppPhoneNumber, getWhatsAppChatType as _bs_23_getWhatsAppChatType, isValidWhatsAppNumber as _bs_24_isValidWhatsAppNumber, isWhatsAppGroup as _bs_25_isWhatsAppGroup, isWhatsAppGroupJid as _bs_26_isWhatsAppGroupJid, isWhatsAppUserTarget as _bs_27_isWhatsAppUserTarget, normalizeE164 as _bs_28_normalizeE164, normalizeWhatsAppTarget as _bs_29_normalizeWhatsAppTarget, resolveWhatsAppSystemLocation as _bs_30_resolveWhatsAppSystemLocation, truncateText as _bs_31_truncateText, WHATSAPP_TEXT_CHUNK_LIMIT as _bs_32_WHATSAPP_TEXT_CHUNK_LIMIT } from "./normalize";
import { sanitizeAccountId as _bs_33_sanitizeAccountId, WhatsAppPairingSession as _bs_34_WhatsAppPairingSession, whatsappAuthExists as _bs_35_whatsappAuthExists, whatsappLogout as _bs_36_whatsappLogout } from "./pairing-service";
import { WhatsAppConnectorService as _bs_37_WhatsAppConnectorService } from "./runtime-service";
import { stopAllPairingSessions as _bs_38_stopAllPairingSessions, whatsappSetupRoutes as _bs_39_whatsappSetupRoutes } from "./setup-routes";
// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name.
// biome-ignore lint/correctness/noUnusedVariables: bundle-safety sink.
const __bundle_safety_PLUGINS_PLUGIN_WHATSAPP_SRC_INDEX__ = [_bs_1_checkWhatsAppUserAccess, _bs_2_DEFAULT_ACCOUNT_ID, _bs_3_isMultiAccountEnabled, _bs_4_isWhatsAppMentionRequired, _bs_5_isWhatsAppUserAllowed, _bs_6_listEnabledWhatsAppAccounts, _bs_7_listWhatsAppAccountIds, _bs_8_normalizeAccountId, _bs_9_resolveDefaultWhatsAppAccountId, _bs_10_resolveWhatsAppAccount, _bs_11_resolveWhatsAppGroupConfig, _bs_12_resolveWhatsAppToken, _bs_13_applyWhatsAppQrOverride, _bs_14_handleWhatsAppRoute, _bs_15_MAX_PAIRING_SESSIONS, _bs_16_ClientFactory, _bs_17_createWhatsAppConnectorAccountProvider, _bs_18_WHATSAPP_PROVIDER_ID, _bs_19_buildWhatsAppUserJid, _bs_20_chunkWhatsAppText, _bs_21_formatWhatsAppId, _bs_22_formatWhatsAppPhoneNumber, _bs_23_getWhatsAppChatType, _bs_24_isValidWhatsAppNumber, _bs_25_isWhatsAppGroup, _bs_26_isWhatsAppGroupJid, _bs_27_isWhatsAppUserTarget, _bs_28_normalizeE164, _bs_29_normalizeWhatsAppTarget, _bs_30_resolveWhatsAppSystemLocation, _bs_31_truncateText, _bs_32_WHATSAPP_TEXT_CHUNK_LIMIT, _bs_33_sanitizeAccountId, _bs_34_WhatsAppPairingSession, _bs_35_whatsappAuthExists, _bs_36_whatsappLogout, _bs_37_WhatsAppConnectorService, _bs_38_stopAllPairingSessions, _bs_39_whatsappSetupRoutes];
// biome-ignore lint/suspicious/noExplicitAny: bundle-safety sink.
(globalThis as any).__bundle_safety_PLUGINS_PLUGIN_WHATSAPP_SRC_INDEX__ = __bundle_safety_PLUGINS_PLUGIN_WHATSAPP_SRC_INDEX__;
