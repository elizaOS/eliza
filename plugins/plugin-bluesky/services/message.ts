import {
	ChannelType,
	type Content,
	composePrompt,
	createUniqueUuid,
	type IAgentRuntime,
	type Memory,
	type MessageConnectorChatContext,
	type MessageConnectorQueryContext,
	type MessageConnectorTarget,
	type MessageConnectorUserContext,
	ModelType,
	type TargetInfo,
} from "@elizaos/core";
import type { BlueSkyClient } from "../client";
import { generateDmTemplate } from "../generated/prompts/typescript/prompts.js";
import type { BlueSkyConversation, BlueSkyMessage } from "../types";
import {
	normalizeBlueSkyAccountId,
	readBlueSkyAccountId,
} from "../utils/config";

const BLUESKY_CONNECTOR_CONTEXTS = ["social", "connectors"];

function normalizeBlueSkyQuery(value: string): string {
	return value.trim().replace(/^@/, "").toLowerCase();
}

function scoreBlueSkyMatch(
	query: string,
	id: string,
	labels: Array<string | null | undefined>,
): number {
	if (!query) return 0.45;
	if (id.toLowerCase() === query) return 1;

	let bestScore = 0;
	for (const label of labels) {
		const normalized = label?.trim().replace(/^@/, "").toLowerCase();
		if (!normalized) continue;
		if (normalized === query) {
			bestScore = Math.max(bestScore, 0.95);
		} else if (normalized.startsWith(query)) {
			bestScore = Math.max(bestScore, 0.85);
		} else if (normalized.includes(query)) {
			bestScore = Math.max(bestScore, 0.7);
		}
	}
	return bestScore;
}

export class BlueSkyMessageService {
	static serviceType = "IMessageService";

	constructor(
		private readonly client: BlueSkyClient,
		private readonly runtime: IAgentRuntime,
		public readonly accountId: string = "default",
	) {}

	getAccountId(): string {
		return normalizeBlueSkyAccountId(this.accountId);
	}

	async getMessages(convoId: string, limit = 50): Promise<BlueSkyMessage[]> {
		const response = await this.client.getMessages(convoId, limit);
		return response.messages;
	}

	async sendMessage(convoId: string, text: string): Promise<BlueSkyMessage> {
		const messageText = text.trim() || (await this.generateReply());
		return this.client.sendMessage({ convoId, message: { text: messageText } });
	}

	async getConversations(limit = 50): Promise<BlueSkyConversation[]> {
		const response = await this.client.getConversations(limit);
		return response.conversations;
	}

	async handleSendMessage(
		runtime: IAgentRuntime,
		target: TargetInfo,
		content: Content,
	): Promise<void> {
		const requestedAccountId = normalizeBlueSkyAccountId(
			target.accountId ??
				readBlueSkyAccountId(content, target) ??
				this.getAccountId(),
		);
		if (requestedAccountId !== this.getAccountId()) {
			throw new Error(
				`BlueSky account '${requestedAccountId}' is not available in this service instance`,
			);
		}

		const text = typeof content.text === "string" ? content.text.trim() : "";
		if (!text) {
			throw new Error("BlueSky DM connector requires non-empty text content.");
		}

		let convoId = target.channelId ?? target.threadId;
		if (!convoId && target.roomId) {
			const room = await runtime.getRoom(target.roomId);
			convoId = room?.channelId;
		}
		if (!convoId) {
			throw new Error("BlueSky DM connector requires a conversation target.");
		}

		await this.sendMessage(convoId, text);
	}

	async fetchConnectorMessages(
		context: MessageConnectorQueryContext,
		params: {
			target?: TargetInfo;
			limit?: number;
			before?: string;
			after?: string;
		} = {},
	): Promise<Memory[]> {
		const requestedAccountId = normalizeBlueSkyAccountId(
			context.accountId ?? context.metadata?.accountId ?? this.getAccountId(),
		);
		if (requestedAccountId !== this.getAccountId()) {
			throw new Error(
				`BlueSky account '${requestedAccountId}' is not available in this service instance`,
			);
		}

		const target = params.target ?? context.target;
		let convoId = target?.channelId ?? target?.threadId;
		if (!convoId && target?.roomId) {
			const room = await context.runtime.getRoom(target.roomId);
			convoId = room?.channelId;
		}

		if (convoId) {
			const messages = await this.getMessages(
				convoId,
				clampLimit(params.limit, 25, 100),
			);
			return messages.map((message) =>
				this.messageToMemory(context.runtime, message, convoId),
			);
		}

		const conversations = await this.getConversations(
			clampLimit(params.limit, 25, 50),
		);
		const memories: Memory[] = [];
		for (const conversation of conversations) {
			const messages = await this.getMessages(conversation.id, 1);
			memories.push(
				...messages.map((message) =>
					this.messageToMemory(context.runtime, message, conversation.id),
				),
			);
		}
		return memories.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
	}

	async resolveConnectorTargets(
		query: string,
		_context: MessageConnectorQueryContext,
	): Promise<MessageConnectorTarget[]> {
		const normalizedQuery = normalizeBlueSkyQuery(query);
		const conversations = await this.getConversations(50);
		return conversations
			.map((conversation) => {
				const score = scoreBlueSkyMatch(normalizedQuery, conversation.id, [
					...conversation.members.flatMap((member) => [
						member.handle,
						member.displayName,
						member.did,
					]),
				]);
				return score > 0
					? this.buildConversationTarget(conversation, score)
					: null;
			})
			.filter((target): target is MessageConnectorTarget => Boolean(target))
			.slice(0, 25);
	}

	async listConnectorRooms(
		_context: MessageConnectorQueryContext,
	): Promise<MessageConnectorTarget[]> {
		const conversations = await this.getConversations(50);
		return conversations.map((conversation) =>
			this.buildConversationTarget(conversation, 0.5),
		);
	}

	async listRecentConnectorTargets(
		context: MessageConnectorQueryContext,
	): Promise<MessageConnectorTarget[]> {
		const targets: MessageConnectorTarget[] = [];
		const room =
			context.roomId && typeof context.runtime.getRoom === "function"
				? await context.runtime.getRoom(context.roomId)
				: null;
		const convoId = context.target?.channelId ?? room?.channelId;

		if (convoId) {
			targets.push({
				target: {
					source: "bluesky",
					accountId: this.getAccountId(),
					channelId: convoId,
				} as TargetInfo,
				label: `BlueSky conversation ${convoId}`,
				kind: "thread",
				score: 0.95,
				contexts: [...BLUESKY_CONNECTOR_CONTEXTS],
				metadata: { accountId: this.getAccountId(), blueskyConvoId: convoId },
			});
		}

		targets.push(...(await this.listConnectorRooms(context)));
		const seen = new Set<string>();
		return targets
			.filter((target) => {
				const channelId = target.target.channelId;
				if (!channelId || seen.has(channelId)) return false;
				seen.add(channelId);
				return true;
			})
			.slice(0, 25);
	}

	async getConnectorChatContext(
		target: TargetInfo,
		context: MessageConnectorQueryContext,
	): Promise<MessageConnectorChatContext | null> {
		let convoId = target.channelId ?? target.threadId;
		if (!convoId && target.roomId) {
			const room = await context.runtime.getRoom(target.roomId);
			convoId = room?.channelId;
		}
		if (!convoId) return null;

		const messages = await this.getMessages(convoId, 25);
		return {
			target: {
				source: "bluesky",
				accountId: this.getAccountId(),
				channelId: convoId,
			} as TargetInfo,
			label: `BlueSky conversation ${convoId}`,
			recentMessages: messages.map((message) => ({
				name: message.sender.did,
				text: message.text ?? "",
				timestamp: Date.parse(message.sentAt),
				metadata: {
					accountId: this.getAccountId(),
					blueskyMessageId: message.id,
					blueskySenderDid: message.sender.did,
				},
			})),
			metadata: { accountId: this.getAccountId(), blueskyConvoId: convoId },
		};
	}

	async getConnectorUserContext(
		entityId: string,
		_context: MessageConnectorQueryContext,
	): Promise<MessageConnectorUserContext | null> {
		const normalizedEntity = entityId.trim().replace(/^@/, "");
		if (!normalizedEntity) return null;

		const conversations = await this.getConversations(50);
		for (const conversation of conversations) {
			const member = conversation.members.find(
				(candidate) =>
					candidate.did === entityId ||
					candidate.handle === normalizedEntity ||
					candidate.displayName === entityId,
			);
			if (!member) continue;

			return {
				entityId,
				label: member.displayName || member.handle || member.did,
				aliases: [member.handle, member.displayName, member.did].filter(
					(value): value is string => Boolean(value),
				),
				handles: {
					bluesky: member.handle ?? member.did,
				},
				metadata: {
					accountId: this.getAccountId(),
					blueskyDid: member.did,
					blueskyHandle: member.handle,
					avatar: member.avatar,
				},
			};
		}

		return null;
	}

	private buildConversationTarget(
		conversation: BlueSkyConversation,
		score: number,
	): MessageConnectorTarget {
		const sessionDid = this.client.getSession()?.did;
		const otherMembers = conversation.members.filter(
			(member) => member.did !== sessionDid,
		);
		const label =
			otherMembers
				.map((member) => member.displayName || member.handle || member.did)
				.filter(Boolean)
				.join(", ") || `BlueSky conversation ${conversation.id}`;

		return {
			target: {
				source: "bluesky",
				accountId: this.getAccountId(),
				channelId: conversation.id,
			} as TargetInfo,
			label,
			kind: "thread",
			description: "BlueSky direct message conversation",
			score,
			contexts: [...BLUESKY_CONNECTOR_CONTEXTS],
			metadata: {
				accountId: this.getAccountId(),
				blueskyConvoId: conversation.id,
				unreadCount: conversation.unreadCount,
				muted: conversation.muted,
				members: conversation.members.map((member) => ({
					did: member.did,
					handle: member.handle,
					displayName: member.displayName,
				})),
			},
		};
	}

	private messageToMemory(
		runtime: IAgentRuntime,
		message: BlueSkyMessage,
		convoId: string,
	): Memory {
		const senderDid = message.sender.did || "unknown";
		const createdAt = Date.parse(message.sentAt) || Date.now();
		const entityId =
			senderDid === runtime.agentId
				? runtime.agentId
				: createUniqueUuid(runtime, `bluesky:user:${senderDid}`);
		const roomId = createUniqueUuid(runtime, `bluesky:dm:${convoId}`);

		return {
			id: createUniqueUuid(runtime, `bluesky:dm:${message.id}`),
			agentId: runtime.agentId,
			entityId,
			roomId,
			createdAt,
			content: {
				text: message.text ?? "",
				source: "bluesky",
				channelType: ChannelType.DM,
			},
			metadata: {
				type: "message",
				source: "bluesky",
				accountId: this.getAccountId(),
				provider: "bluesky",
				timestamp: createdAt,
				fromBot: entityId === runtime.agentId,
				messageIdFull: message.id,
				chatType: ChannelType.DM,
				sender: {
					id: senderDid,
				},
				bluesky: {
					accountId: this.getAccountId(),
					messageId: message.id,
					convoId,
					rev: message.rev,
					senderDid,
				},
			} as unknown as Memory["metadata"],
		};
	}

	private async generateReply(): Promise<string> {
		const prompt = composePrompt({
			state: {},
			template: generateDmTemplate,
		});
		const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
			prompt,
			maxTokens: 50,
		});
		return response as string;
	}
}

function clampLimit(
	value: number | undefined,
	fallback: number,
	max: number,
): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(Math.max(1, Math.floor(value as number)), max);
}
