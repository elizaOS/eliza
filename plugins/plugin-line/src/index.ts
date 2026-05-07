/**
 * LINE Plugin for ElizaOS
 *
 * Provides LINE Messaging API integration for ElizaOS agents,
 * supporting text, flex messages, locations, and more.
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { LINE_MESSAGE_OP_ACTION, messageOp } from "./actions/index.js";
import { LineService } from "./service.js";
import { LineN8nCredentialProvider } from "./n8n-credential-provider.js";

// Account management exports
export {
  DEFAULT_ACCOUNT_ID,
  isLineMentionRequired,
  isLineUserAllowed,
  isMultiAccountEnabled,
  type LineAccountConfig,
  type LineGroupConfig,
  type LineMultiAccountConfig,
  type LineTokenResolution,
  type LineTokenSource,
  listEnabledLineAccounts,
  listLineAccountIds,
  normalizeAccountId,
  type ResolvedLineAccount,
  resolveDefaultLineAccountId,
  resolveLineAccount,
  resolveLineGroupConfig,
  resolveLineSecret,
  resolveLineToken,
} from "./accounts.js";
// Messaging utilities exports
export {
  buildLineDeepLink,
  type ChunkLineTextOpts,
  type CodeBlock,
  chunkLineText,
  extractCodeBlocks,
  extractLinks,
  extractMarkdownTables,
  formatCodeBlockAsText,
  formatLineUser,
  formatTableAsText,
  getChatId,
  getChatType,
  hasMarkdownContent,
  isGroupChat,
  LINE_MAX_REPLY_MESSAGES,
  LINE_TEXT_CHUNK_LIMIT,
  type MarkdownLink,
  type MarkdownTable,
  markdownToLineChunks,
  type ProcessedLineMessage,
  processLineMessage,
  resolveLineSystemLocation,
  stripMarkdown,
  truncateText,
} from "./messaging.js";
// Re-export types and service
export * from "./types.js";
export { LINE_MESSAGE_OP_ACTION, LineService, messageOp };

/**
 * LINE plugin for ElizaOS agents.
 */
const linePlugin: Plugin = {
  name: "line",
  description: "LINE Messaging API plugin for ElizaOS agents",

  services: [LineService, LineN8nCredentialProvider],
  actions: [messageOp],
  providers: [],
  tests: [],

  init: async (config: Record<string, string>, _runtime: IAgentRuntime): Promise<void> => {
    logger.info("Initializing LINE plugin...");

    const hasAccessToken = Boolean(
      config.LINE_CHANNEL_ACCESS_TOKEN || process.env.LINE_CHANNEL_ACCESS_TOKEN
    );
    const hasSecret = Boolean(config.LINE_CHANNEL_SECRET || process.env.LINE_CHANNEL_SECRET);

    logger.info("LINE plugin configuration:");
    logger.info(`  - Access token configured: ${hasAccessToken ? "Yes" : "No"}`);
    logger.info(`  - Channel secret configured: ${hasSecret ? "Yes" : "No"}`);
    logger.info(
      `  - DM policy: ${config.LINE_DM_POLICY || process.env.LINE_DM_POLICY || "pairing"}`
    );
    logger.info(
      `  - Group policy: ${config.LINE_GROUP_POLICY || process.env.LINE_GROUP_POLICY || "allowlist"}`
    );

    if (!hasAccessToken) {
      logger.warn("LINE channel access token not configured. Set LINE_CHANNEL_ACCESS_TOKEN.");
    }

    if (!hasSecret) {
      logger.warn("LINE channel secret not configured. Set LINE_CHANNEL_SECRET.");
    }

    logger.info("LINE plugin initialized");
  },
};

export default linePlugin;
