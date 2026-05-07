import type { Plugin } from "@elizaos/core";
import { SEND_MESSAGE_ACTION, sendMessageAction } from "./actions";
import { FEISHU_SERVICE_NAME } from "./constants";
import { MessageManager } from "./messageManager";
import { CHAT_STATE_PROVIDER, chatStateProvider } from "./providers";
import { FeishuService } from "./service";
import { FeishuN8nCredentialProvider } from "./n8n-credential-provider";

const feishuPlugin: Plugin = {
	name: FEISHU_SERVICE_NAME,
	description: "Feishu/Lark client plugin for elizaOS",
	services: [FeishuService, FeishuN8nCredentialProvider],
	actions: [],
	providers: [chatStateProvider],
	tests: [],
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
export {
	CHAT_STATE_PROVIDER,
	chatStateProvider,
	FEISHU_SERVICE_NAME,
	FeishuService,
	MessageManager,
	SEND_MESSAGE_ACTION,
	sendMessageAction,
};

export default feishuPlugin;

// Channel configuration types
export type {
	FeishuActionConfig,
	FeishuConfig,
	FeishuReactionNotificationMode,
} from "./config";
