import {
	ChannelType,
	createUniqueUuid,
	EventType,
	type IAgentRuntime,
	logger,
	type Memory,
	type UUID,
} from "@elizaos/core";
import type * as lark from "@larksuiteoapi/node-sdk";
import { MAX_MESSAGE_LENGTH } from "./constants";
import type { FeishuConfig } from "./environment";
import { isChatAllowed } from "./environment";
import type {
	FeishuChat,
	FeishuChatType,
	FeishuEventData,
	FeishuMessage,
	FeishuMessageContent,
	FeishuMessageReceivedPayload,
	FeishuUser,
} from "./types";
import { FeishuEventTypes } from "./types";

/**
 * Manages message handling for the Feishu service.
 */
export class MessageManager {
	private client: lark.Client;
	private runtime: IAgentRuntime;
	private config: FeishuConfig;
	private processedMessages: Set<string> = new Set();
	private botOpenId: string | null = null;

	constructor(
		client: lark.Client,
		runtime: IAgentRuntime,
		config: FeishuConfig,
	) {
		this.client = client;
		this.runtime = runtime;
		this.config = config;
	}

	/**
	 * Sets the bot's open ID for mention detection.
	 */
	setBotOpenId(openId: string): void {
		this.botOpenId = openId;
	}

	/**
	 * Handles incoming message events.
	 */
	async handleMessage(event: FeishuEventData): Promise<void> {
		try {
			const message = event.event?.message as FeishuMessage | undefined;
			if (!message) {
				return;
			}

			// Deduplicate messages
			if (this.processedMessages.has(message.messageId)) {
				return;
			}
			this.processedMessages.add(message.messageId);

			// Limit cache size
			if (this.processedMessages.size > 1000) {
				const firstKey = this.processedMessages.values().next().value as string;
				this.processedMessages.delete(firstKey);
			}

			const chatId = message.chatId;
			const chatType = (event.event?.chat_type || "p2p") as FeishuChatType;

			// Check if chat is allowed
			if (!isChatAllowed(this.config, chatId)) {
				logger.debug(`[Feishu] Chat ${chatId} not authorized, skipping`);
				return;
			}

			// Parse sender information
			const sender = this.parseSender(event);

			// Ignore bot messages if configured
			if (this.config.shouldIgnoreBotMessages && sender.isBot) {
				logger.debug("[Feishu] Ignoring bot message");
				return;
			}

			// Check for mentions if configured
			if (this.config.shouldRespondOnlyToMentions && chatType !== "p2p") {
				if (!this.isBotMentioned(message)) {
					logger.debug("[Feishu] Bot not mentioned, skipping");
					return;
				}
			}

			// Parse message content
			const text = this.parseMessageContent(message);

			// Build chat info
			const chat: FeishuChat = {
				chatId,
				chatType: chatType as FeishuChatType,
				name: (event.event?.chat_name as string | undefined) || undefined,
			};

			// Create room and entity IDs
			const roomId = createUniqueUuid(this.runtime, chatId) as UUID;
			const entityId = createUniqueUuid(this.runtime, sender.openId) as UUID;
			const worldId = createUniqueUuid(this.runtime, chatId) as UUID;

			// Ensure connection exists
			await this.runtime.ensureConnection({
				entityId,
				roomId,
				userName: sender.name,
				userId: sender.openId as UUID,
				name: sender.name || "Unknown User",
				source: "feishu",
				channelId: chatId,
				messageServerId: worldId,
				type: chatType === "p2p" ? ChannelType.DM : ChannelType.GROUP,
				worldId,
			});

			// Create memory for the message
			const memory: Memory = {
				id: createUniqueUuid(this.runtime, message.messageId) as UUID,
				entityId,
				roomId,
				agentId: this.runtime.agentId,
				content: {
					text,
					source: "feishu",
					chatId,
					messageId: message.messageId,
				},
				createdAt: Number.parseInt(message.createTime, 10),
			};

			// Emit message received event
			const payload: FeishuMessageReceivedPayload = {
				runtime: this.runtime,
				message: memory,
				source: "feishu",
				originalMessage: message,
				chat,
				sender,
			};

			this.runtime.emitEvent(FeishuEventTypes.MESSAGE_RECEIVED, payload);
			this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, payload);
		} catch (error) {
			logger.error(
				`[Feishu] Error handling message: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Sends a message to a chat.
	 */
	async sendMessage(
		chatId: string,
		content: FeishuMessageContent,
	): Promise<string[]> {
		const messageIds: string[] = [];

		try {
			const text = content.text || "";

			// Handle card messages
			if (content.card) {
				const response = await this.client.im.message.create({
					params: { receive_id_type: "chat_id" },
					data: {
						receive_id: chatId,
						msg_type: "interactive",
						content: JSON.stringify(content.card),
					},
				});
				if (response.data?.message_id) {
					messageIds.push(response.data.message_id);
				}
				return messageIds;
			}

			// Handle image messages
			if (content.imageKey) {
				const response = await this.client.im.message.create({
					params: { receive_id_type: "chat_id" },
					data: {
						receive_id: chatId,
						msg_type: "image",
						content: JSON.stringify({ image_key: content.imageKey }),
					},
				});
				if (response.data?.message_id) {
					messageIds.push(response.data.message_id);
				}
				return messageIds;
			}

			// Split long messages
			const parts = this.splitMessage(text);

			for (const part of parts) {
				const response = await this.client.im.message.create({
					params: { receive_id_type: "chat_id" },
					data: {
						receive_id: chatId,
						msg_type: "text",
						content: JSON.stringify({ text: part }),
					},
				});
				if (response.data?.message_id) {
					messageIds.push(response.data.message_id);
				}
			}

			return messageIds;
		} catch (error) {
			logger.error(
				`[Feishu] Error sending message: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	/**
	 * Replies to a specific message.
	 */
	async replyToMessage(
		messageId: string,
		content: FeishuMessageContent,
	): Promise<string[]> {
		const messageIds: string[] = [];

		try {
			const text = content.text || "";
			const parts = this.splitMessage(text);

			for (const part of parts) {
				const response = await this.client.im.message.reply({
					path: { message_id: messageId },
					data: {
						msg_type: "text",
						content: JSON.stringify({ text: part }),
					},
				});
				if (response.data?.message_id) {
					messageIds.push(response.data.message_id);
				}
			}

			return messageIds;
		} catch (error) {
			logger.error(
				`[Feishu] Error replying to message: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	/**
	 * Parses sender information from an event.
	 */
	private parseSender(event: FeishuEventData): FeishuUser {
		const sender = event.event?.sender as
			| {
					sender_id?: {
						open_id?: string;
						union_id?: string;
						user_id?: string;
					};
					sender_type?: string;
			  }
			| undefined;

		const isBot = sender?.sender_type === "app";
		const openId = sender?.sender_id?.open_id || "";

		return {
			openId,
			unionId: sender?.sender_id?.union_id,
			userId: sender?.sender_id?.user_id,
			isBot,
		};
	}

	/**
	 * Parses message content to extract text.
	 */
	private parseMessageContent(message: FeishuMessage): string {
		try {
			const content = JSON.parse(message.content);

			switch (message.msgType) {
				case "text":
					return content.text || "";

				case "post":
					// Rich text - extract plain text
					return this.extractTextFromPost(content);

				case "image":
				case "file":
				case "audio":
				case "video":
				case "sticker":
					return `[${message.msgType}]`;

				case "interactive":
					return "[interactive card]";

				default:
					return content.text || "";
			}
		} catch {
			return "";
		}
	}

	/**
	 * Extracts plain text from a rich text (post) message.
	 */
	private extractTextFromPost(content: {
		title?: string;
		content?: { tag: string; text?: string }[][];
	}): string {
		const parts: string[] = [];

		if (content.title) {
			parts.push(content.title);
		}

		if (content.content && Array.isArray(content.content)) {
			for (const line of content.content) {
				if (Array.isArray(line)) {
					const lineText = line
						.filter((elem) => elem.tag === "text" && elem.text)
						.map((elem) => elem.text)
						.join("");
					if (lineText) {
						parts.push(lineText);
					}
				}
			}
		}

		return parts.join("\n");
	}

	/**
	 * Checks if the bot is mentioned in the message.
	 */
	private isBotMentioned(message: FeishuMessage): boolean {
		if (!this.botOpenId || !message.mentions) {
			return false;
		}

		return message.mentions.some((mention) => mention.id === this.botOpenId);
	}

	/**
	 * Splits a long message into chunks.
	 */
	private splitMessage(content: string): string[] {
		if (content.length <= MAX_MESSAGE_LENGTH) {
			return [content];
		}

		const parts: string[] = [];
		let current = "";

		for (const line of content.split("\n")) {
			const lineWithNewline = current ? `\n${line}` : line;

			if (current.length + lineWithNewline.length > MAX_MESSAGE_LENGTH) {
				if (current) {
					parts.push(current);
					current = "";
				}

				if (line.length > MAX_MESSAGE_LENGTH) {
					// Split very long lines by words
					const words = line.split(/\s+/);
					for (const word of words) {
						const wordWithSpace = current ? ` ${word}` : word;
						if (current.length + wordWithSpace.length > MAX_MESSAGE_LENGTH) {
							if (current) {
								parts.push(current);
								current = "";
							}
							if (word.length > MAX_MESSAGE_LENGTH) {
								// Split very long words
								for (let i = 0; i < word.length; i += MAX_MESSAGE_LENGTH) {
									parts.push(word.slice(i, i + MAX_MESSAGE_LENGTH));
								}
							} else {
								current = word;
							}
						} else {
							current += wordWithSpace;
						}
					}
				} else {
					current = line;
				}
			} else {
				current += lineWithNewline;
			}
		}

		if (current) {
			parts.push(current);
		}

		return parts;
	}
}
