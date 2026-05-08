/**
 * iMessage Plugin for elizaOS
 *
 * Provides iMessage integration for Eliza agents on macOS.
 * Uses AppleScript and/or CLI tools to send and receive messages.
 */

import { platform } from "node:os";
import { getConnectorAccountManager, type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import { createIMessageConnectorAccountProvider } from "./connector-account-provider.js";
// The former iMessage-specific send action duplicated the MessageConnector
// path. The connector registered by IMessageService.registerSendHandlers is
// now the canonical delivery path through MESSAGE operation=send. This plugin
// no longer registers its own send action.
import { chatContextProvider, contactsProvider } from "./providers/index.js";
import {
  chatDbMessageToPublicShape,
  IMessageService,
  parseChatsFromAppleScript,
  parseMessagesFromAppleScript,
} from "./service.js";
import { imessageSetupRoutes } from "./setup-routes.js";

// Account management exports
export {
  DEFAULT_ACCOUNT_ID,
  type IMessageAccountConfig,
  type IMessageGroupConfig,
  type IMessageMultiAccountConfig,
  isIMessageMentionRequired,
  isIMessageUserAllowed,
  isMultiAccountEnabled,
  listEnabledIMessageAccounts,
  listIMessageAccountIds,
  normalizeAccountId,
  type ResolvedIMessageAccount,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
  resolveIMessageGroupConfig,
} from "./accounts.js";
// chat.db reader (bun:sqlite-backed inbound polling)
export {
  appleDateToJsMs,
  type ChatDbAccessIssue,
  type ChatDbMessage,
  type ChatDbReader,
  createFullDiskAccessAction,
  DEFAULT_CHAT_DB_PATH,
  getLastChatDbAccessIssue,
  MACOS_FULL_DISK_ACCESS_SETTINGS_URL,
  openChatDb,
} from "./chatdb-reader.js";
// Apple Contacts reader (display-name resolution for inbound handles)
export {
  addContact,
  type ContactPatch,
  type ContactsMap,
  deleteContact,
  type FullContact,
  listAllContacts,
  loadContacts,
  type NewContactInput,
  normalizeContactHandle,
  parseContactsOutput,
  type ResolvedContact,
  updateContact,
} from "./contacts-reader.js";
// RPC client exports
export {
  createIMessageRpcClient,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  getChatInfo,
  getContactInfo,
  getMessages,
  type IMessageAttachment,
  type IMessageChat,
  type IMessageContact,
  type IMessageMessage,
  IMessageRpcClient,
  type IMessageRpcClientOptions,
  type IMessageRpcError,
  type IMessageRpcNotification,
  type IMessageRpcResponse,
  listChats,
  listContacts,
  probeIMessageRpc,
  sendIMessageRpc,
} from "./rpc.js";
// Re-export types and service
export * from "./types.js";
export {
  chatContextProvider,
  chatDbMessageToPublicShape,
  contactsProvider,
  IMessageService,
  parseChatsFromAppleScript,
  parseMessagesFromAppleScript,
};

/**
 * iMessage plugin for Eliza agents.
 */
const imessagePlugin: Plugin = {
  name: "imessage",
  description: "iMessage plugin for Eliza agents (macOS only)",

  services: [IMessageService],
  actions: [],
  providers: [chatContextProvider, contactsProvider],
  routes: imessageSetupRoutes,
  tests: [],

  init: async (config: Record<string, string>, runtime: IAgentRuntime): Promise<void> => {
    logger.info("Initializing iMessage plugin...");

    // Register the iMessage provider with the ConnectorAccountManager so the
    // HTTP CRUD surface (packages/agent/src/api/connector-account-routes.ts)
    // can list, create, patch, and delete iMessage accounts.
    try {
      const manager = getConnectorAccountManager(runtime);
      manager.registerProvider(createIMessageConnectorAccountProvider(runtime));
    } catch (err) {
      logger.warn(
        {
          src: "plugin:imessage",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register iMessage provider with ConnectorAccountManager"
      );
    }

    const isMacOS = platform() === "darwin";

    logger.info("iMessage plugin configuration:");
    logger.info(`  - Platform: ${platform()}`);
    logger.info(`  - macOS: ${isMacOS ? "Yes" : "No"}`);
    logger.info(
      `  - CLI path: ${config.IMESSAGE_CLI_PATH || process.env.IMESSAGE_CLI_PATH || "imsg (default)"}`
    );
    logger.info(
      `  - DM policy: ${config.IMESSAGE_DM_POLICY || process.env.IMESSAGE_DM_POLICY || "pairing"}`
    );

    if (!isMacOS) {
      logger.warn(
        "iMessage plugin is only supported on macOS. The plugin will be inactive on this platform."
      );
    }

    logger.info("iMessage plugin initialized");
  },
};

export default imessagePlugin;

// Channel configuration types
export type {
  IMessageConfig,
  IMessageReactionNotificationMode,
} from "./config.js";
// ConnectorAccountManager provider exports
export {
  createIMessageConnectorAccountProvider,
  IMESSAGE_PROVIDER_ID,
} from "./connector-account-provider.js";
