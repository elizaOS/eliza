import type { Plugin, TestSuite } from "@elizaos/core";
import {
  DELETE_MESSAGE_ACTION,
  deleteMessageAction,
  EDIT_MESSAGE_ACTION,
  editMessageAction,
  SEND_MESSAGE_ACTION,
  SEND_REACTION_ACTION,
  SEND_STICKER_ACTION,
  sendMessageAction,
  sendReactionAction,
  sendStickerAction,
} from "./actions";
import { TELEGRAM_SERVICE_NAME } from "./constants";
import {
  buildTelegramSettings,
  type TelegramSettings,
  type TelegramUpdateMode,
  validateTelegramConfig,
} from "./environment";
import { MessageManager } from "./messageManager";
import { CHAT_STATE_PROVIDER, chatStateProvider } from "./providers";
import { TelegramService } from "./service";
import { TelegramTestSuite } from "./tests";
import {
  type SendReactionParams,
  type SendReactionResult,
  TELEGRAM_REACTIONS,
  type TelegramBotInfo,
  type TelegramBotProbe,
  type TelegramContent,
  TelegramEventTypes,
  type TelegramReactionEmoji,
} from "./types";

const telegramPlugin: Plugin = {
  name: TELEGRAM_SERVICE_NAME,
  description: "Telegram client plugin with polling and webhook support",
  services: [TelegramService],
  actions: [
    sendMessageAction,
    sendReactionAction,
    editMessageAction,
    deleteMessageAction,
    sendStickerAction,
  ],
  providers: [chatStateProvider],
  tests: [new TelegramTestSuite() as unknown as TestSuite],
};

export {
  telegramPlugin,
  // Service
  TelegramService,
  MessageManager,
  // Actions
  sendMessageAction,
  SEND_MESSAGE_ACTION,
  sendReactionAction,
  SEND_REACTION_ACTION,
  editMessageAction,
  EDIT_MESSAGE_ACTION,
  deleteMessageAction,
  DELETE_MESSAGE_ACTION,
  sendStickerAction,
  SEND_STICKER_ACTION,
  // Providers
  chatStateProvider,
  CHAT_STATE_PROVIDER,
  // Types
  TelegramEventTypes,
  TELEGRAM_REACTIONS,
  type TelegramContent,
  type TelegramBotProbe,
  type SendReactionParams,
  type SendReactionResult,
  type TelegramBotInfo,
  type TelegramReactionEmoji,
  type TelegramSettings,
  type TelegramUpdateMode,
  // Config utilities
  buildTelegramSettings,
  validateTelegramConfig,
};

// Account management exports
export {
  DEFAULT_ACCOUNT_ID,
  isMultiAccountEnabled,
  listEnabledTelegramAccounts,
  listTelegramAccountIds,
  normalizeAccountId,
  normalizeTelegramToken,
  type ResolvedTelegramAccount,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
  resolveTelegramToken,
  type TelegramAccountRuntimeConfig,
  type TelegramDmConfig,
  type TelegramGroupRuntimeConfig,
  type TelegramMultiAccountConfig,
  type TelegramTokenResolution,
  type TelegramTokenSource,
} from "./accounts";

// Formatting exports
export {
  buildTelegramDeepLink,
  buildTelegramMessageLink,
  type ChunkTelegramTextOpts,
  chunkTelegramText,
  escapeHtml,
  escapeHtmlAttr,
  escapeMarkdownV2,
  formatMediaCaption,
  formatTelegramChat,
  formatTelegramUser,
  formatTelegramUserMention,
  getChatTypeString,
  isChannelChat,
  isGroupChat,
  isPrivateChat,
  type MarkdownToTelegramOptions,
  markdownToTelegramChunks,
  markdownToTelegramHtml,
  markdownToTelegramHtmlChunks,
  parseTelegramMessageLink,
  resolveTelegramSystemLocation,
  stripHtmlTags,
  type TelegramFormattedChunk,
  truncateText,
} from "./formatting";

export default telegramPlugin;

// Channel configuration types
export type {
  TelegramAccountConfig,
  TelegramActionConfig,
  TelegramCapabilitiesConfig,
  TelegramChannelConfig,
  TelegramConfig,
  TelegramCustomCommand,
  TelegramGroupConfig,
  TelegramInlineButtonsScope,
  TelegramNetworkConfig,
  TelegramTopicConfig,
} from "./config";
