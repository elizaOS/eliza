import {
	type Content,
	composePrompt,
	type IAgentRuntime,
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
					channelId: convoId,
				} as TargetInfo,
				label: `BlueSky conversation ${convoId}`,
				kind: "thread",
				score: 0.95,
				contexts: [...BLUESKY_CONNECTOR_CONTEXTS],
				metadata: { blueskyConvoId: convoId },
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
				channelId: convoId,
			} as TargetInfo,
			label: `BlueSky conversation ${convoId}`,
			recentMessages: messages.map((message) => ({
				name: message.sender.did,
				text: message.text ?? "",
				timestamp: Date.parse(message.sentAt),
				metadata: {
					blueskyMessageId: message.id,
					blueskySenderDid: message.sender.did,
				},
			})),
			metadata: { blueskyConvoId: convoId },
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
				channelId: conversation.id,
			} as TargetInfo,
			label,
			kind: "thread",
			description: "BlueSky direct message conversation",
			score,
			contexts: [...BLUESKY_CONNECTOR_CONTEXTS],
			metadata: {
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
