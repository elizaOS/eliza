import {
	ChannelType,
	type Content,
	createUniqueUuid,
	type HandlerCallback,
	type IAgentRuntime,
	logger,
	type Media,
	type Memory,
	ModelTypes,
	Role,
	type UUID,
} from "@elizaos/core";
import type { Chat, Message, ReactionType, Update } from "@telegraf/types";
import type { Context, NarrowedContext, Telegraf } from "telegraf";
import { escapeMarkdown } from "./utils";

import fs from "node:fs";

export enum MediaType {
	PHOTO = "photo",
	VIDEO = "video",
	DOCUMENT = "document",
	AUDIO = "audio",
	ANIMATION = "animation",
}

const MAX_MESSAGE_LENGTH = 4096; // Telegram's max message length

const getChannelType = (chat: Chat): ChannelType => {
	if (chat.type === "private") return ChannelType.DM;
	if (chat.type === "supergroup") return ChannelType.GROUP;
	if (chat.type === "channel") return ChannelType.GROUP;
	if (chat.type === "group") return ChannelType.GROUP;
};

export class MessageManager {
	public bot: Telegraf<Context>;
	protected runtime: IAgentRuntime;

	constructor(bot: Telegraf<Context>, runtime: IAgentRuntime) {
		this.bot = bot;
		this.runtime = runtime;
	}

	// Process image messages and generate descriptions
	private async processImage(
		message: Message,
	): Promise<{ description: string } | null> {
		try {
			let imageUrl: string | null = null;

			logger.info(`Telegram Message: ${message}`);

			if ("photo" in message && message.photo?.length > 0) {
				const photo = message.photo[message.photo.length - 1];
				const fileLink = await this.bot.telegram.getFileLink(photo.file_id);
				imageUrl = fileLink.toString();
			} else if (
				"document" in message &&
				message.document?.mime_type?.startsWith("image/")
			) {
				const fileLink = await this.bot.telegram.getFileLink(
					message.document.file_id,
				);
				imageUrl = fileLink.toString();
			}

			if (imageUrl) {
				const { title, description } = await this.runtime.useModel(
					ModelTypes.IMAGE_DESCRIPTION,
					imageUrl,
				);
				return { description: `[Image: ${title}\n${description}]` };
			}
		} catch (error) {
			console.error("❌ Error processing image:", error);
		}

		return null;
	}

	// Send long messages in chunks
	private async sendMessageInChunks(
		ctx: Context,
		content: Content,
		replyToMessageId?: number,
	): Promise<Message.TextMessage[]> {
		if (content.attachments && content.attachments.length > 0) {
			content.attachments.map(async (attachment: Media) => {
				const typeMap: { [key: string]: MediaType } = {
					"image/gif": MediaType.ANIMATION,
					image: MediaType.PHOTO,
					doc: MediaType.DOCUMENT,
					video: MediaType.VIDEO,
					audio: MediaType.AUDIO,
				};

				let mediaType: MediaType | undefined = undefined;

				for (const prefix in typeMap) {
					if (attachment.contentType.startsWith(prefix)) {
						mediaType = typeMap[prefix];
						break;
					}
				}

				if (!mediaType) {
					throw new Error(
						`Unsupported Telegram attachment content type: ${attachment.contentType}`,
					);
				}

				await this.sendMedia(
					ctx,
					attachment.url,
					mediaType,
					attachment.description,
				);
			});
		} else {
			const chunks = this.splitMessage(content.text);
			const sentMessages: Message.TextMessage[] = [];

			for (let i = 0; i < chunks.length; i++) {
				const chunk = escapeMarkdown(chunks[i]);
				const sentMessage = (await ctx.telegram.sendMessage(
					ctx.chat.id,
					chunk,
					{
						reply_parameters:
							i === 0 && replyToMessageId
								? { message_id: replyToMessageId }
								: undefined,
						parse_mode: "Markdown",
					},
				)) as Message.TextMessage;

				sentMessages.push(sentMessage);
			}

			return sentMessages;
		}
	}

	private async sendMedia(
		ctx: Context,
		mediaPath: string,
		type: MediaType,
		caption?: string,
	): Promise<void> {
		try {
			const isUrl = /^(http|https):\/\//.test(mediaPath);
			const sendFunctionMap: Record<MediaType, Function> = {
				[MediaType.PHOTO]: ctx.telegram.sendPhoto.bind(ctx.telegram),
				[MediaType.VIDEO]: ctx.telegram.sendVideo.bind(ctx.telegram),
				[MediaType.DOCUMENT]: ctx.telegram.sendDocument.bind(ctx.telegram),
				[MediaType.AUDIO]: ctx.telegram.sendAudio.bind(ctx.telegram),
				[MediaType.ANIMATION]: ctx.telegram.sendAnimation.bind(ctx.telegram),
			};

			const sendFunction = sendFunctionMap[type];

			if (!sendFunction) {
				throw new Error(`Unsupported media type: ${type}`);
			}

			if (isUrl) {
				// Handle HTTP URLs
				await sendFunction(ctx.chat.id, mediaPath, { caption });
			} else {
				// Handle local file paths
				if (!fs.existsSync(mediaPath)) {
					throw new Error(`File not found at path: ${mediaPath}`);
				}

				const fileStream = fs.createReadStream(mediaPath);

				try {
					await sendFunction(ctx.chat.id, { source: fileStream }, { caption });
				} finally {
					fileStream.destroy();
				}
			}

			logger.info(
				`${
					type.charAt(0).toUpperCase() + type.slice(1)
				} sent successfully: ${mediaPath}`,
			);
		} catch (error) {
			logger.error(
				`Failed to send ${type}. Path: ${mediaPath}. Error: ${error.message}`,
			);
			logger.debug(error.stack);
			throw error;
		}
	}

	// Split message into smaller parts
	private splitMessage(text: string): string[] {
		const chunks: string[] = [];
		let currentChunk = "";

		const lines = text.split("\n");
		for (const line of lines) {
			if (currentChunk.length + line.length + 1 <= MAX_MESSAGE_LENGTH) {
				currentChunk += (currentChunk ? "\n" : "") + line;
			} else {
				if (currentChunk) chunks.push(currentChunk);
				currentChunk = line;
			}
		}

		if (currentChunk) chunks.push(currentChunk);
		return chunks;
	}

	// Main handler for incoming messages
	public async handleMessage(ctx: Context): Promise<void> {
		// Type guard to ensure message exists
		if (!ctx.message || !ctx.from) return;

		const message = ctx.message as Message.TextMessage;

		try {
			// Convert IDs to UUIDs
			const entityId = createUniqueUuid(
				this.runtime,
				ctx.from.id.toString(),
			) as UUID;
			const userName =
				ctx.from.username || ctx.from.first_name || "Unknown User";
			const chatId = createUniqueUuid(this.runtime, ctx.chat?.id.toString());
			const roomId = chatId;

			// Get message ID
			const messageId = createUniqueUuid(
				this.runtime,
				message?.message_id?.toString(),
			);

			// Handle images
			const imageInfo = await this.processImage(message);

			// Get message text - use type guards for safety
			let messageText = "";
			if ("text" in message && message.text) {
				messageText = message.text;
			} else if ("caption" in message && message.caption) {
				messageText = message.caption as string;
			}

			// Combine text and image description
			const fullText = imageInfo
				? `${messageText} ${imageInfo.description}`
				: messageText;
			if (!fullText) return;

			// Create the memory object
			const memory: Memory = {
				id: messageId,
				entityId,
				agentId: this.runtime.agentId,
				roomId,
				content: {
					text: fullText,
					source: "telegram",
					channelType: getChannelType(message.chat as Chat),
					// name: userName,
					// userName: userName,
					// Safely access reply_to_message with type guard
					inReplyTo:
						"reply_to_message" in message && message.reply_to_message
							? createUniqueUuid(
									this.runtime,
									message.reply_to_message.message_id.toString(),
								)
							: undefined,
				},
				createdAt: message.date * 1000,
			};

			// if its a telegram group of multiple chats, we need to get the name of the group chat
			const chat = message.chat as Chat;

			// Get world name from supergroup/channel title, or use chat title as fallback
			const worldName =
				chat.type === "supergroup"
					? (chat as Chat.SupergroupChat).title
					: chat.type === "channel"
						? (chat as Chat.ChannelChat).title
						: "undefined";

			// Get room name from chat title/first name
			const roomName =
				chat.type === "private"
					? (chat as Chat.PrivateChat).first_name
					: chat.type === "supergroup"
						? (chat as Chat.SupergroupChat).title
						: chat.type === "channel"
							? (chat as Chat.ChannelChat).title
							: chat.type === "group"
								? (chat as Chat.GroupChat).title
								: "Unknown Group";

			await this.runtime.ensureConnection({
				entityId,
				roomId,
				userName,
				name: userName,
				source: "telegram",
				channelId: ctx.chat.id.toString(),
				serverId: chat.id.toString(),
				type: getChannelType(chat),
			});

			// TODO: chat.id is probably used incorrectly here and needs to be fixed
			const channelType = getChannelType(chat);
			const worldId = createUniqueUuid(this.runtime, chat.id.toString());
			const room = {
				id: roomId,
				name: roomName,
				source: "telegram",
				type: channelType,
				channelId: ctx.chat.id.toString(),
				serverId: ctx.chat.id.toString(),
				worldId: worldId,
			};
			// TODO: chat.id is probably used incorrectly here and needs to be fixed
			const ownerId = chat.id; // this might be wrong
			if (channelType === ChannelType.GROUP) {
				// if the type is a group, we need to get the world id from the supergroup/channel id
				await this.runtime.ensureWorldExists({
					id: worldId,
					name: worldName,
					serverId: chat.id.toString(),
					agentId: this.runtime.agentId,
					metadata: {
						ownership:
							chat.type === "supergroup"
								? { ownerId: chat.id.toString() }
								: undefined,
						roles: {
							// TODO: chat.id is probably wrong key for this
							[ownerId]: Role.OWNER,
						},
					},
				});
				room.worldId = worldId;
			}

			await this.runtime.ensureRoomExists(room);

			// Create callback for handling responses
			const callback: HandlerCallback = async (
				content: Content,
				_files?: string[],
			) => {
				try {
					const sentMessages = await this.sendMessageInChunks(
						ctx,
						content,
						message.message_id,
					);

					if (!sentMessages) return [];

					const memories: Memory[] = [];
					for (let i = 0; i < sentMessages.length; i++) {
						const sentMessage = sentMessages[i];
						const _isLastMessage = i === sentMessages.length - 1;

						const responseMemory: Memory = {
							id: createUniqueUuid(
								this.runtime,
								sentMessage.message_id.toString(),
							),
							entityId: this.runtime.agentId,
							agentId: this.runtime.agentId,
							roomId,
							content: {
								...content,
								text: sentMessage.text,
								inReplyTo: messageId,
								channelType: getChannelType(message.chat as Chat),
							},
							createdAt: sentMessage.date * 1000,
						};

						await this.runtime
							.getMemoryManager("messages")
							.createMemory(responseMemory);
						memories.push(responseMemory);
					}

					return memories;
				} catch (error) {
					logger.error("Error in message callback:", error);
					return [];
				}
			};

			// Let the bootstrap plugin handle the message
			this.runtime.emitEvent(
				["TELEGRAM_MESSAGE_RECEIVED", "MESSAGE_RECEIVED"],
				{
					runtime: this.runtime,
					message: memory,
					callback,
				},
			);
		} catch (error) {
			logger.error("❌ Error handling message:", error);
			logger.error("Error sending message:", error);
			throw error;
		}
	}

	public async handleReaction(
		ctx: NarrowedContext<Context<Update>, Update.MessageReactionUpdate>,
	): Promise<void> {
		// Ensure we have the necessary data
		if (!ctx.update.message_reaction || !ctx.from) return;

		const reaction = ctx.update.message_reaction;
		const reactionType = reaction.new_reaction[0].type;
		const reactionEmoji = (reaction.new_reaction[0] as ReactionType).type;

		try {
			const entityId = createUniqueUuid(
				this.runtime,
				ctx.from.id.toString(),
			) as UUID;
			const roomId = createUniqueUuid(this.runtime, ctx.chat.id.toString());

			const reactionId = createUniqueUuid(
				this.runtime,
				`${reaction.message_id}-${ctx.from.id}-${Date.now()}`,
			);

			// Create reaction memory
			const memory: Memory = {
				id: reactionId,
				entityId,
				agentId: this.runtime.agentId,
				roomId,
				content: {
					channelType: getChannelType(reaction.chat as Chat),
					text: `Reacted with: ${reactionType === "emoji" ? reactionEmoji : reactionType}`,
					source: "telegram",
					// name: ctx.from.first_name,
					// userName: ctx.from.username,
					inReplyTo: createUniqueUuid(
						this.runtime,
						reaction.message_id.toString(),
					),
				},
				createdAt: Date.now(),
			};
			await this.runtime.getMemoryManager("messages").createMemory(memory);

			// Create callback for handling reaction responses
			const callback: HandlerCallback = async (content: Content) => {
				try {
					const sentMessage = await ctx.reply(content.text);
					const responseMemory: Memory = {
						id: createUniqueUuid(
							this.runtime,
							sentMessage.message_id.toString(),
						),
						entityId: this.runtime.agentId,
						agentId: this.runtime.agentId,
						roomId,
						content: {
							...content,
							inReplyTo: reactionId,
						},
						createdAt: sentMessage.date * 1000,
					};
					return [responseMemory];
				} catch (error) {
					logger.error("Error in reaction callback:", error);
					return [];
				}
			};

			// Let the bootstrap plugin handle the reaction
			this.runtime.emitEvent(
				["TELEGRAM_REACTION_RECEIVED", "REACTION_RECEIVED"],
				{
					runtime: this.runtime,
					message: memory,
					callback,
				},
			);
		} catch (error) {
			logger.error("Error handling reaction:", error);
		}
	}
}
