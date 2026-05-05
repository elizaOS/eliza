/**
 * Cross-platform message triage — shared type contract.
 *
 * A MessageRef is the canonical representation of a single inbound message,
 * independent of its source platform. Adapters normalize platform-native
 * payloads into MessageRefs; the triage engine scores them; actions expose
 * them to agents.
 */

import type { IAgentRuntime } from "../../../types/index.ts";

export type MessageSource =
	| "gmail"
	| "discord"
	| "telegram"
	| "twitter"
	| "imessage"
	| "signal"
	| "whatsapp"
	| "calendly"
	| "browser_bridge";

export const ALL_MESSAGE_SOURCES: readonly MessageSource[] = [
	"gmail",
	"discord",
	"telegram",
	"twitter",
	"imessage",
	"signal",
	"whatsapp",
	"calendly",
	"browser_bridge",
] as const;

export type TriagePriority = "critical" | "high" | "medium" | "low" | "spam";

export type SuggestedAction =
	| "respond-now"
	| "respond-today"
	| "respond-this-week"
	| "archive"
	| "skip";

export interface TriageScore {
	priority: TriagePriority;
	reason: string;
	suggestedAction: SuggestedAction;
	contactWeight: number;
	urgencyKeywords: string[];
	scoredAt: number;
}

export interface MessageParticipant {
	identifier: string;
	displayName?: string;
	contactId?: string;
}

export interface MessageRef {
	id: string;
	source: MessageSource;
	externalId: string;
	threadId?: string;
	from: MessageParticipant;
	to: Array<{ identifier: string; displayName?: string }>;
	subject?: string;
	snippet: string;
	body?: string;
	receivedAtMs: number;
	hasAttachments: boolean;
	isRead: boolean;
	triageScore?: TriageScore;
	/** Account/server scope: gmail address, discord server id, phone #, etc. */
	worldId?: string;
	/** Label/folder/channel/room/conversation id within a world. */
	channelId?: string;
	/** User/agent labels — persisted in the store and searchable. */
	tags?: string[];
	/** Connector-specific extras (also acts as an extension envelope). */
	metadata?: Record<string, unknown>;
}

export interface DraftRequest {
	source: MessageSource;
	/** Original message being replied to, if any. */
	inReplyToId?: string;
	threadId?: string;
	to: Array<{ identifier: string; displayName?: string }>;
	subject?: string;
	body: string;
	worldId?: string;
	channelId?: string;
	metadata?: Record<string, unknown>;
}

export interface DraftRecord {
	draftId: string;
	source: MessageSource;
	inReplyToId?: string;
	threadId?: string;
	to: Array<{ identifier: string; displayName?: string }>;
	subject?: string;
	body: string;
	preview: string;
	createdAtMs: number;
	sent: boolean;
	sentExternalId?: string;
	worldId?: string;
	channelId?: string;
	metadata?: Record<string, unknown>;
	/** Set when scheduleSend has been invoked but the message hasn't gone out. */
	scheduledForMs?: number;
	scheduledId?: string;
}

export interface ListOptions {
	sinceMs?: number;
	limit?: number;
	worldIds?: string[];
	channelIds?: string[];
}

export interface MessageAdapterCapabilities {
	list: boolean;
	search: boolean;
	manage: {
		archive?: boolean;
		trash?: boolean;
		spam?: boolean;
		label?: boolean;
		tag?: boolean;
		muteThread?: boolean;
		markRead?: boolean;
		unsubscribe?: boolean;
	};
	send: { reply?: boolean; new?: boolean; schedule?: boolean };
	worlds: "single" | "multi";
	channels: "explicit" | "implicit" | "none";
}

export interface SearchMessagesFilters {
	sources?: MessageSource[];
	worldIds?: string[];
	channelIds?: string[];
	sender?: { identifier?: string; displayName?: string };
	/** Free-text content query — adapter or fallback in-memory match. */
	content?: string;
	/** AND-match all tags. */
	tags?: string[];
	sinceMs?: number;
	untilMs?: number;
	limit?: number;
}

export type ManageOperation =
	| { kind: "archive" }
	| { kind: "trash" }
	| { kind: "spam" }
	| { kind: "mark_read"; read: boolean }
	| { kind: "label_add"; label: string }
	| { kind: "label_remove"; label: string }
	| { kind: "tag_add"; tag: string }
	| { kind: "tag_remove"; tag: string }
	| { kind: "mute_thread" }
	| { kind: "unsubscribe" };

export interface ManageResult {
	ok: boolean;
	/** Populated when ok=false (e.g. "not supported by adapter"). */
	reason?: string;
}

export interface MessageAdapter {
	readonly source: MessageSource;
	isAvailable(runtime: IAgentRuntime): boolean;
	capabilities(): MessageAdapterCapabilities;
	listMessages(
		runtime: IAgentRuntime,
		opts: ListOptions,
	): Promise<MessageRef[]>;
	getMessage(runtime: IAgentRuntime, id: string): Promise<MessageRef | null>;
	searchMessages?(
		runtime: IAgentRuntime,
		filters: SearchMessagesFilters,
	): Promise<MessageRef[]>;
	manageMessage?(
		runtime: IAgentRuntime,
		messageId: string,
		op: ManageOperation,
	): Promise<ManageResult>;
	createDraft(
		runtime: IAgentRuntime,
		draft: DraftRequest,
	): Promise<{ draftId: string; preview: string }>;
	sendDraft(
		runtime: IAgentRuntime,
		draftId: string,
	): Promise<{ externalId: string }>;
	scheduleSend?(
		runtime: IAgentRuntime,
		draftId: string,
		sendAtMs: number,
	): Promise<{ scheduledId: string }>;
}

export class NotYetImplementedError extends Error {
	constructor(feature: string) {
		super(`NotYetImplemented: ${feature}`);
		this.name = "NotYetImplementedError";
	}
}
