/**
 * iMessage Plugin for elizaOS
 *
 * Provides iMessage integration for elizaOS agents on macOS.
 * Uses AppleScript and/or CLI tools to send and receive messages.
 */

import { platform } from "node:os";
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { sendMessage } from "./actions/index.js";
import { chatContextProvider } from "./providers/index.js";
import {
  IMessageService,
  parseChatsFromAppleScript,
  parseMessagesFromAppleScript,
} from "./service.js";

// Re-export types and service
export * from "./types.js";
export {
  IMessageService,
  parseMessagesFromAppleScript,
  parseChatsFromAppleScript,
};
export { sendMessage };
export { chatContextProvider };

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

/**
 * iMessage plugin for elizaOS agents.
 */
const imessagePlugin: Plugin = {
  name: "imessage",
  description: "iMessage plugin for elizaOS agents (macOS only)",

  services: [IMessageService],
  actions: [sendMessage],
  providers: [chatContextProvider],
  tests: [],

  init: async (
    config: Record<string, string>,
    _runtime: IAgentRuntime,
  ): Promise<void> => {
    logger.info("Initializing iMessage plugin...");

    const isMacOS = platform() === "darwin";

    logger.info("iMessage plugin configuration:");
    logger.info(`  - Platform: ${platform()}`);
    logger.info(`  - macOS: ${isMacOS ? "Yes" : "No"}`);
    logger.info(
      `  - CLI path: ${config.IMESSAGE_CLI_PATH || process.env.IMESSAGE_CLI_PATH || "imsg (default)"}`,
    );
    logger.info(
      `  - DM policy: ${config.IMESSAGE_DM_POLICY || process.env.IMESSAGE_DM_POLICY || "pairing"}`,
    );

    if (!isMacOS) {
      logger.warn(
        "iMessage plugin is only supported on macOS. The plugin will be inactive on this platform.",
      );
    }

    logger.info("iMessage plugin initialized");
  },
};

export default imessagePlugin;

// Channel configuration types (IMessageAccountConfig already exported from accounts.js)
export type {
  IMessageConfig,
  IMessageReactionNotificationMode,
} from "./config.js";
