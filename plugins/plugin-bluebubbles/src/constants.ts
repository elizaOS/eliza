/**
 * Constants for the BlueBubbles plugin
 */

export const BLUEBUBBLES_SERVICE_NAME = "bluebubbles";
export const DEFAULT_WEBHOOK_PATH = "/webhooks/bluebubbles";
export const DEFAULT_TEXT_CHUNK_LIMIT = 4000;

// DM Policy options
export const DM_POLICY_OPEN = "open";
export const DM_POLICY_PAIRING = "pairing";
export const DM_POLICY_ALLOWLIST = "allowlist";
export const DM_POLICY_DISABLED = "disabled";

// Group Policy options
export const GROUP_POLICY_OPEN = "open";
export const GROUP_POLICY_ALLOWLIST = "allowlist";
export const GROUP_POLICY_DISABLED = "disabled";

// API endpoints
export const API_ENDPOINTS = {
	SERVER_INFO: "/api/v1/server/info",
	MESSAGE_TEXT: "/api/v1/message/text",
	SEND_ATTACHMENT: "/api/v1/message/attachment",
	CHAT_INFO: "/api/v1/chat",
	CHAT_QUERY: "/api/v1/chat/query",
	CREATE_CHAT: "/api/v1/chat/new",
	MESSAGES: "/api/v1/message",
	MARK_READ: "/api/v1/chat/:guid/read",
	HANDLE_INFO: "/api/v1/handle",
	REACT: "/api/v1/message/react",
	EDIT: "/api/v1/message/:guid/edit",
	UNSEND: "/api/v1/message/:guid/unsend",
} as const;

// Message types
export const MESSAGE_TYPES = {
	TEXT: "text",
	ATTACHMENT: "attachment",
	REACTION: "reaction",
	GROUP_ACTION: "group_action",
} as const;
