/**
 * Type definitions for the BlueBubbles plugin
 */

export type DmPolicy = "open" | "pairing" | "allowlist" | "disabled";
export type GroupPolicy = "open" | "allowlist" | "disabled";

export interface BlueBubblesConfig {
	serverUrl: string;
	password: string;
	webhookPath?: string;
	autoStartCommand?: string;
	autoStartArgs?: string[];
	autoStartCwd?: string;
	autoStartWaitMs?: number;
	dmPolicy?: DmPolicy;
	groupPolicy?: GroupPolicy;
	allowFrom?: string[];
	groupAllowFrom?: string[];
	sendReadReceipts?: boolean;
	enabled?: boolean;
}

export interface BlueBubblesMessage {
	guid: string;
	text: string | null;
	subject: string | null;
	country: string | null;
	handle: BlueBubblesHandle | null;
	handleId: number;
	otherHandle: number;
	chats: BlueBubblesChat[];
	attachments: BlueBubblesAttachment[];
	expressiveSendStyleId: string | null;
	dateCreated: number;
	dateRead: number | null;
	dateDelivered: number | null;
	isFromMe: boolean;
	isDelayed: boolean;
	isAutoReply: boolean;
	isSystemMessage: boolean;
	isServiceMessage: boolean;
	isForward: boolean;
	isArchived: boolean;
	hasDdResults: boolean;
	hasPayloadData: boolean;
	threadOriginatorGuid: string | null;
	threadOriginatorPart: string | null;
	associatedMessageGuid: string | null;
	associatedMessageType: string | null;
	balloonBundleId: string | null;
	dateEdited: number | null;
	error: number;
	itemType: number;
	groupTitle: string | null;
	groupActionType: number;
	payloadData: Record<string, unknown> | null;
}

export interface BlueBubblesHandle {
	address: string;
	service: string;
	country: string | null;
	originalROWID: number;
	uncanonicalizedId: string | null;
}

export interface BlueBubblesChat {
	guid: string;
	chatIdentifier: string;
	displayName: string | null;
	participants: BlueBubblesHandle[];
	lastMessage: BlueBubblesMessage | null;
	style: number;
	isArchived: boolean;
	isFiltered: boolean;
	isPinned: boolean;
	hasUnreadMessages: boolean;
}

export interface BlueBubblesAttachment {
	guid: string;
	originalROWID: number;
	uti: string;
	mimeType: string | null;
	transferName: string;
	totalBytes: number;
	isOutgoing: boolean;
	hideAttachment: boolean;
	isSticker: boolean;
	hasLivePhoto: boolean;
	height: number | null;
	width: number | null;
	metadata: Record<string, unknown> | null;
}

export interface BlueBubblesServerInfo {
	os_version: string;
	server_version: string;
	private_api: boolean;
	proxy_service: string | null;
	helper_connected: boolean;
	detected_icloud: string | null;
}

export interface BlueBubblesWebhookPayload {
	type: string;
	data: BlueBubblesMessage | BlueBubblesChat | Record<string, unknown>;
}

export interface SendMessageOptions {
	tempGuid?: string;
	method?: "apple-script" | "private-api";
	subject?: string;
	effectId?: string;
	selectedMessageGuid?: string;
	partIndex?: number;
	ddScan?: boolean;
}

export interface SendMessageResult {
	guid: string;
	tempGuid?: string;
	status: "sent" | "delivered" | "failed";
	dateCreated: number;
	text: string;
	error?: string;
}

export interface SendAttachmentOptions extends SendMessageOptions {
	name?: string;
	isAudioMessage?: boolean;
}

export interface BlueBubblesProbeResult {
	ok: boolean;
	serverVersion?: string;
	osVersion?: string;
	privateApiEnabled?: boolean;
	helperConnected?: boolean;
	error?: string;
}

export interface BlueBubblesChatState {
	chatGuid: string;
	chatIdentifier: string;
	isGroup: boolean;
	participants: string[];
	displayName: string | null;
	lastMessageAt: number | null;
	hasUnread: boolean;
}

// Event types for webhook processing
export type BlueBubblesEventType =
	| "new-message"
	| "updated-message"
	| "typing-indicator"
	| "read-receipt"
	| "chat-updated"
	| "participant-added"
	| "participant-removed"
	| "group-name-changed"
	| "group-icon-changed"
	| "group-icon-removed";

export interface BlueBubblesIncomingEvent {
	type: BlueBubblesEventType;
	data: BlueBubblesMessage | BlueBubblesChat | Record<string, unknown>;
}
