import type { IAgentRuntime } from "@elizaos/core";
import { FEISHU_DOMAINS } from "./constants";

/**
 * Configuration for the Feishu service.
 */
export interface FeishuConfig {
	/** Application ID (cli_xxx format) */
	appId: string;
	/** Application secret */
	appSecret: string;
	/** Domain: 'feishu' for China or 'lark' for global */
	domain: "feishu" | "lark";
	/** API base URL */
	apiRoot: string;
	/** Allowed chat IDs (empty means all allowed) */
	allowedChatIds: string[];
	/** Test chat ID for testing */
	testChatId?: string;
	/** Whether to ignore bot messages */
	shouldIgnoreBotMessages: boolean;
	/** Whether to respond only to mentions */
	shouldRespondOnlyToMentions: boolean;
}

/**
 * Validates and returns the Feishu configuration from runtime settings.
 */
export function getFeishuConfig(runtime: IAgentRuntime): FeishuConfig | null {
	const appId = runtime.getSetting("FEISHU_APP_ID") as string | undefined;
	const appSecret = runtime.getSetting("FEISHU_APP_SECRET") as
		| string
		| undefined;

	if (!appId || !appSecret) {
		return null;
	}

	const domainSetting = (
		runtime.getSetting("FEISHU_DOMAIN") as string | undefined
	)?.toLowerCase();
	const domain: "feishu" | "lark" =
		domainSetting === "lark" ? "lark" : "feishu";

	const apiRoot = FEISHU_DOMAINS[domain];

	let allowedChatIds: string[] = [];
	const allowedChatsRaw = runtime.getSetting("FEISHU_ALLOWED_CHATS") as
		| string
		| undefined;
	if (allowedChatsRaw) {
		try {
			const parsed = JSON.parse(allowedChatsRaw);
			if (Array.isArray(parsed)) {
				allowedChatIds = parsed.map(String);
			}
		} catch {
			// Invalid JSON, ignore
		}
	}

	const testChatId = runtime.getSetting("FEISHU_TEST_CHAT_ID") as
		| string
		| undefined;

	const shouldIgnoreBotMessages =
		(
			runtime.getSetting("FEISHU_IGNORE_BOT_MESSAGES") as string
		)?.toLowerCase() !== "false";

	const shouldRespondOnlyToMentions =
		(
			runtime.getSetting("FEISHU_RESPOND_ONLY_TO_MENTIONS") as string
		)?.toLowerCase() === "true";

	return {
		appId,
		appSecret,
		domain,
		apiRoot,
		allowedChatIds,
		testChatId,
		shouldIgnoreBotMessages,
		shouldRespondOnlyToMentions,
	};
}

/**
 * Validates the Feishu configuration.
 */
export function validateConfig(config: FeishuConfig): {
	valid: boolean;
	error?: string;
} {
	if (!config.appId) {
		return { valid: false, error: "FEISHU_APP_ID is required" };
	}

	if (!config.appId.startsWith("cli_")) {
		return { valid: false, error: "FEISHU_APP_ID should start with 'cli_'" };
	}

	if (!config.appSecret) {
		return { valid: false, error: "FEISHU_APP_SECRET is required" };
	}

	return { valid: true };
}

/**
 * Checks if a chat is allowed based on configuration.
 */
export function isChatAllowed(config: FeishuConfig, chatId: string): boolean {
	if (config.allowedChatIds.length === 0) {
		return true;
	}
	return config.allowedChatIds.includes(chatId);
}
