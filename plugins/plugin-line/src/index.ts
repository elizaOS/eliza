/**
 * LINE Plugin for ElizaOS
 *
 * Provides LINE Messaging API integration for ElizaOS agents,
 * supporting text, flex messages, locations, and more.
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { getConnectorAccountManager, logger } from "@elizaos/core";
import { createLineConnectorAccountProvider } from "./connector-account-provider.js";
import { LineService } from "./service.js";
import { LineWorkflowCredentialProvider } from "./workflow-credential-provider.js";

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
export { LineService };

/**
 * LINE plugin for ElizaOS agents.
 */
const linePlugin: Plugin = {
  name: "line",
  description: "LINE Messaging API plugin for ElizaOS agents",

  services: [LineService, LineWorkflowCredentialProvider],
  actions: [],
  providers: [],
  tests: [],

  init: async (config: Record<string, string>, runtime: IAgentRuntime): Promise<void> => {
    logger.info("Initializing LINE plugin...");

    // Register the LINE provider with the ConnectorAccountManager so the HTTP
    // CRUD surface (packages/agent/src/api/connector-account-routes.ts) can
    // list, create, patch, and delete LINE accounts.
    try {
      const manager = getConnectorAccountManager(runtime);
      manager.registerProvider(createLineConnectorAccountProvider(runtime));
    } catch (err) {
      logger.warn(
        {
          src: "plugin:line",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register LINE provider with ConnectorAccountManager"
      );
    }

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
