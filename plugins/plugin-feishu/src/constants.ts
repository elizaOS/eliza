/**
 * Service name used to register and retrieve the Feishu service.
 */
export const FEISHU_SERVICE_NAME = "feishu";

/**
 * Default API domains for Feishu and Lark.
 */
export const FEISHU_DOMAINS = {
	feishu: "https://open.feishu.cn",
	lark: "https://open.larksuite.com",
} as const;

/**
 * Maximum message length for Feishu text messages.
 */
export const MAX_MESSAGE_LENGTH = 4000;

/**
 * Default timeout for API requests in milliseconds.
 */
export const DEFAULT_TIMEOUT_MS = 30000;
