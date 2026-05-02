import type {
	Content,
	EntityPayload,
	MessagePayload,
	WorldPayload,
} from "@elizaos/core";

/**
 * Feishu event data structure (local type since lark SDK doesn't export it)
 */
export interface FeishuEventData {
	event?: Record<string, unknown>;
	header?: {
		event_id?: string;
		token?: string;
		create_time?: string;
		event_type?: string;
		tenant_key?: string;
		app_id?: string;
	};
}

/**
 * Base content type for Feishu messages (extends Content for compatibility).
 * Note: Do not add FeishuCard directly to this interface as it conflicts with Content's index signature.
 */
export interface FeishuContent extends Content {
	/** Image key for image messages */
	feishuImageKey?: string;
	/** File key for file messages */
	feishuFileKey?: string;
}

/**
 * Internal type for Feishu-specific content with card support (not exported to Content).
 * This type is used internally for message sending/receiving.
 */
export interface FeishuMessageContent {
	text?: string;
	/** Interactive card content */
	card?: FeishuCard;
	/** Image key for image messages */
	imageKey?: string;
	/** File key for file messages */
	fileKey?: string;
}

/**
 * Helper type for accessing Feishu-specific card content (internal use)
 */
export type FeishuCardContent = {
	card?: FeishuCard;
	imageKey?: string;
	fileKey?: string;
};

/**
 * Feishu interactive card structure.
 */
export interface FeishuCard {
	/** Card configuration */
	config?: {
		wideScreenMode?: boolean;
		enableForward?: boolean;
	};
	/** Card header */
	header?: {
		title?: {
			tag: string;
			content: string;
		};
		template?: string;
	};
	/** Card elements */
	elements?: FeishuCardElement[];
}

/**
 * Card element types.
 */
export type FeishuCardElement =
	| { tag: "div"; text: { tag: string; content: string } }
	| { tag: "action"; actions: FeishuCardAction[] }
	| { tag: "hr" }
	| { tag: "note"; elements: { tag: string; content: string }[] };

/**
 * Card action types.
 */
export interface FeishuCardAction {
	tag: "button";
	text: { tag: string; content: string };
	type?: "default" | "primary" | "danger";
	url?: string;
	value?: Record<string, string>;
}

/**
 * Event types emitted by the Feishu plugin.
 */
export enum FeishuEventTypes {
	WORLD_JOINED = "FEISHU_WORLD_JOINED",
	WORLD_CONNECTED = "FEISHU_WORLD_CONNECTED",
	WORLD_LEFT = "FEISHU_WORLD_LEFT",
	ENTITY_JOINED = "FEISHU_ENTITY_JOINED",
	ENTITY_LEFT = "FEISHU_ENTITY_LEFT",
	ENTITY_UPDATED = "FEISHU_ENTITY_UPDATED",
	MESSAGE_RECEIVED = "FEISHU_MESSAGE_RECEIVED",
	MESSAGE_SENT = "FEISHU_MESSAGE_SENT",
	REACTION_RECEIVED = "FEISHU_REACTION_RECEIVED",
	INTERACTION_RECEIVED = "FEISHU_INTERACTION_RECEIVED",
	SLASH_START = "FEISHU_SLASH_START",
}

/**
 * Map of event types to their payload types.
 */
export interface FeishuEventPayloadMap {
	[FeishuEventTypes.MESSAGE_RECEIVED]: FeishuMessageReceivedPayload;
	[FeishuEventTypes.MESSAGE_SENT]: FeishuMessageSentPayload;
	[FeishuEventTypes.REACTION_RECEIVED]: FeishuReactionReceivedPayload;
	[FeishuEventTypes.WORLD_JOINED]: FeishuWorldPayload;
	[FeishuEventTypes.WORLD_CONNECTED]: FeishuWorldPayload;
	[FeishuEventTypes.WORLD_LEFT]: FeishuWorldPayload;
	[FeishuEventTypes.SLASH_START]: { chatId: string };
	[FeishuEventTypes.ENTITY_JOINED]: FeishuEntityPayload;
	[FeishuEventTypes.ENTITY_LEFT]: FeishuEntityPayload;
	[FeishuEventTypes.ENTITY_UPDATED]: FeishuEntityPayload;
	[FeishuEventTypes.INTERACTION_RECEIVED]: FeishuInteractionPayload;
}

/**
 * Feishu chat types.
 */
export enum FeishuChatType {
	/** Private one-on-one chat */
	P2P = "p2p",
	/** Group chat */
	GROUP = "group",
}

/**
 * Feishu user information.
 */
export interface FeishuUser {
	/** Open ID (user identifier) */
	openId: string;
	/** Union ID (cross-app identifier) */
	unionId?: string;
	/** User ID (tenant-level identifier) */
	userId?: string;
	/** User's display name */
	name?: string;
	/** User's avatar URL */
	avatarUrl?: string;
	/** Whether the user is a bot */
	isBot?: boolean;
}

/**
 * Feishu chat information.
 */
export interface FeishuChat {
	/** Chat ID */
	chatId: string;
	/** Chat type */
	chatType: FeishuChatType;
	/** Chat name/title */
	name?: string;
	/** Chat owner's open ID */
	ownerOpenId?: string;
	/** Chat description */
	description?: string;
	/** Tenant key */
	tenantKey?: string;
}

/**
 * Feishu message information.
 */
export interface FeishuMessage {
	/** Message ID */
	messageId: string;
	/** Root message ID (for threads) */
	rootId?: string;
	/** Parent message ID (for replies) */
	parentId?: string;
	/** Message type */
	msgType: string;
	/** Message content (JSON string) */
	content: string;
	/** Create time (Unix timestamp in milliseconds) */
	createTime: string;
	/** Update time (Unix timestamp in milliseconds) */
	updateTime?: string;
	/** Whether the message is deleted */
	deleted?: boolean;
	/** Chat ID */
	chatId: string;
	/** Sender information */
	sender: {
		id: string;
		idType: string;
		senderType: string;
		tenantKey?: string;
	};
	/** Mentions in the message */
	mentions?: FeishuMention[];
}

/**
 * Mention information in a message.
 */
export interface FeishuMention {
	/** Mention key in the message */
	key: string;
	/** Mentioned user's ID */
	id: string;
	/** ID type */
	idType: string;
	/** Mentioned user's name */
	name: string;
	/** Tenant key */
	tenantKey?: string;
}

/**
 * Payload for received messages.
 */
export interface FeishuMessageReceivedPayload extends MessagePayload {
	/** Original Feishu message */
	originalMessage: FeishuMessage;
	/** Chat information */
	chat: FeishuChat;
	/** Sender information */
	sender: FeishuUser;
}

/**
 * Payload for sent messages.
 */
export interface FeishuMessageSentPayload extends MessagePayload {
	/** Message IDs of sent messages */
	messageIds: string[];
	/** Chat ID */
	chatId: string;
}

/**
 * Payload for reaction events.
 */
export interface FeishuReactionReceivedPayload
	extends FeishuMessageReceivedPayload {
	/** Reaction type/emoji */
	reactionType: string;
}

/**
 * Payload for world/chat events.
 */
export interface FeishuWorldPayload extends WorldPayload {
	/** Chat information */
	chat: FeishuChat;
	/** Bot's open ID */
	botOpenId?: string;
}

/**
 * Payload for entity (user) events.
 */
export interface FeishuEntityPayload extends EntityPayload {
	/** Feishu user information */
	feishuUser: FeishuUser;
	/** Chat where the event occurred */
	chat: FeishuChat;
}

/**
 * Payload for interaction events (card actions, etc.).
 */
export interface FeishuInteractionPayload {
	/** Interaction type */
	type: string;
	/** Action data */
	action: {
		tag: string;
		value?: Record<string, string>;
	};
	/** User who triggered the interaction */
	user: FeishuUser;
	/** Chat where the interaction occurred */
	chat?: FeishuChat;
	/** Token for responding to the interaction */
	token?: string;
}
