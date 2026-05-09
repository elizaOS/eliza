import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { getConnectorAccountManager, logger } from "@elizaos/core";
import { createFeishuConnectorAccountProvider } from "./connector-account-provider";
import { FEISHU_SERVICE_NAME } from "./constants";
import { MessageManager } from "./messageManager";
import { FeishuService } from "./service";

const feishuPlugin: Plugin = {
	name: FEISHU_SERVICE_NAME,
	description: "Feishu/Lark client plugin for elizaOS",
	services: [FeishuService],
	actions: [],
	providers: [],
	tests: [],
	// Self-declared auto-enable: activate when the "feishu" connector is
	// configured under config.connectors. The hardcoded CONNECTOR_PLUGINS map
	// in plugin-auto-enable-engine.ts still serves as a fallback.
	autoEnable: {
		connectorKeys: ["feishu"],
	},
	init: async (
		_config: Record<string, string>,
		runtime: IAgentRuntime,
	): Promise<void> => {
		try {
			const manager = getConnectorAccountManager(runtime);
			manager.registerProvider(createFeishuConnectorAccountProvider(runtime));
		} catch (err) {
			logger.warn(
				{
					src: "plugin:feishu",
					err: err instanceof Error ? err.message : String(err),
				},
				"Failed to register Feishu provider with ConnectorAccountManager",
			);
		}
	},
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
export { FEISHU_SERVICE_NAME, FeishuService, MessageManager };

export default feishuPlugin;

// Channel configuration types
export type {
	FeishuActionConfig,
	FeishuConfig,
	FeishuReactionNotificationMode,
} from "./config";
