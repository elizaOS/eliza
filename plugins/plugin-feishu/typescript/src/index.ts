import type { Plugin } from "@elizaos/core";
import { SEND_MESSAGE_ACTION, sendMessageAction } from "./actions";
import { FEISHU_SERVICE_NAME } from "./constants";
import { MessageManager } from "./messageManager";
import { CHAT_STATE_PROVIDER, chatStateProvider } from "./providers";
import { FeishuService } from "./service";

const feishuPlugin: Plugin = {
  name: FEISHU_SERVICE_NAME,
  description: "Feishu/Lark client plugin for elizaOS",
  services: [FeishuService],
  actions: [sendMessageAction],
  providers: [chatStateProvider],
  tests: [],
};

export {
  FeishuService,
  MessageManager,
  sendMessageAction,
  SEND_MESSAGE_ACTION,
  chatStateProvider,
  CHAT_STATE_PROVIDER,
  FEISHU_SERVICE_NAME,
};

// Account management exports
export {
  DEFAULT_ACCOUNT_ID,
  type FeishuAccountConfig,
  type FeishuGroupConfig,
  type FeishuMultiAccountConfig,
  type FeishuTokenSource,
  isFeishuMentionRequired,
  isFeishuUserAllowed,
  isMultiAccountEnabled,
  listEnabledFeishuAccounts,
  listFeishuAccountIds,
  normalizeAccountId,
  type ResolvedFeishuAccount,
  resolveDefaultFeishuAccountId,
  resolveFeishuAccount,
  resolveFeishuGroupConfig,
} from "./accounts";
export * from "./constants";
export * from "./environment";
// Formatting exports
export {
  type ChunkFeishuTextOpts,
  chunkFeishuText,
  containsMarkdown,
  FEISHU_TEXT_CHUNK_LIMIT,
  type FeishuFormattedChunk,
  type FeishuPostContent,
  type FeishuPostElement,
  type FeishuPostLine,
  formatFeishuAtAll,
  formatFeishuUserMention,
  isGroupChat,
  markdownToFeishuChunks,
  markdownToFeishuPost,
  resolveFeishuSystemLocation,
  stripMarkdown,
  truncateText,
} from "./formatting";
export * from "./types";

export default feishuPlugin;

// Channel configuration types
export type {
  FeishuAccountConfig,
  FeishuActionConfig,
  FeishuConfig,
  FeishuGroupConfig,
  FeishuReactionNotificationMode,
} from "./config";
