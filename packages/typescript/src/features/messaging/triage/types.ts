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
	| "whatsapp";

export const ALL_MESSAGE_SOURCES: readonly MessageSource[] = [
	"gmail",
	"discord",
	"telegram",
	"twitter",
	"imessage",
	"signal",
	"whatsapp",
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
}

export interface DraftRequest {
	source: MessageSource;
	/** Original message being replied to, if any. */
	inReplyToId?: string;
	threadId?: string;
	to: Array<{ identifier: string; displayName?: string }>;
	subject?: string;
	body: string;
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
}

export interface ListOptions {
	sinceMs?: number;
	limit?: number;
}

export interface MessageAdapter {
	readonly source: MessageSource;
	isAvailable(runtime: IAgentRuntime): boolean;
	listMessages(
		runtime: IAgentRuntime,
		opts: ListOptions,
	): Promise<MessageRef[]>;
	getMessage(runtime: IAgentRuntime, id: string): Promise<MessageRef | null>;
	createDraft(
		runtime: IAgentRuntime,
		draft: DraftRequest,
	): Promise<{ draftId: string; preview: string }>;
	sendDraft(
		runtime: IAgentRuntime,
		draftId: string,
	): Promise<{ externalId: string }>;
}

export class NotYetImplementedError extends Error {
	constructor(feature: string) {
		super(`NotYetImplemented: ${feature}`);
		this.name = "NotYetImplementedError";
	}
}
