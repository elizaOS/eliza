import {
	type Action,
	type ActionExample,
	type ActionResult,
	type Content,
	composePromptFromState,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	type Memory,
	ModelType,
	type State,
} from "@elizaos/core";
import {
	type Message,
	PermissionsBitField,
	type TextChannel,
	type User,
} from "discord.js";
import { DISCORD_SERVICE_NAME } from "../constants";
import {
	pinMessageTemplate,
	reactToMessageTemplate,
	sendDmTemplate,
	unpinMessageTemplate,
} from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import type { DiscordService } from "../service";
import { getActionParameters, parseJsonObjectFromText } from "../utils";
import {
	terminalActionInteractionSemantics,
	terminalActionResultData,
} from "./actionResultSemantics";

type DiscordMessageOp =
	| "send"
	| "reply"
	| "dm"
	| "edit"
	| "delete"
	| "react"
	| "pin"
	| "unpin";

const VALID_OPS: readonly DiscordMessageOp[] = [
	"send",
	"reply",
	"dm",
	"edit",
	"delete",
	"react",
	"pin",
	"unpin",
];

const sendMessageTemplate = `You are helping to extract send message parameters.

The user wants to send a message to a Discord channel.

Recent conversation:
{{recentMessages}}

Extract the following:
1. text: The message text to send
2. channelRef: The channel to send to (default: "current" for the current channel)

Respond with JSON only, no markdown:
{"text":"The message to send","channelRef":"current"}`;

const editMessageTemplate = `You are helping to extract edit message parameters.

The user wants to edit an existing Discord message.

Recent conversation:
{{recentMessages}}

Extract the following:
1. messageId: The ID of the message to edit
2. newText: The new text content for the message
3. channelRef: The channel where the message is (default: "current")

Respond with JSON only, no markdown:
{"messageId":"123456789","newText":"The updated message text","channelRef":"current"}`;

const deleteMessageTemplate = `You are helping to extract delete message parameters.

The user wants to delete a Discord message.

Recent conversation:
{{recentMessages}}

Extract the following:
1. messageId: The ID of the message to delete
2. channelRef: The channel where the message is (default: "current")

Respond with JSON only, no markdown:
{"messageId":"123456789","channelRef":"current"}`;

const opRouterTemplate = `Pick the Discord message operation that matches the user's request.

Recent conversation:
{{recentMessages}}

Allowed values for "op":
- send: post a new message in a channel
- reply: reply to an existing message in a channel
- dm: send a direct message to a user
- edit: edit one of the bot's prior messages
- delete: delete one of the bot's prior messages
- react: add an emoji reaction to a message
- pin: pin a message in a channel
- unpin: unpin a message in a channel

Respond with JSON only, no markdown:
{"op":"send"}`;

function extractEmojisFromText(text: string): string[] {
	if (!text) return [];

	const matches: { index: number; emoji: string }[] = [];

	const unicodeEmojiRegex =
		/(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})(?:️)?(?:‍(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})(?:️)?)*/gu;
	let match: RegExpExecArray | null = unicodeEmojiRegex.exec(text);
	while (match !== null) {
		matches.push({ index: match.index, emoji: match[0] });
		match = unicodeEmojiRegex.exec(text);
	}

	const customEmojiRegex = /<a?:\w+:\d+>/g;
	match = customEmojiRegex.exec(text);
	while (match !== null) {
		matches.push({ index: match.index, emoji: match[0] });
		match = customEmojiRegex.exec(text);
	}

	return matches.sort((a, b) => a.index - b.index).map((m) => m.emoji);
}

function isExplicitReactionRequest(text: string): boolean {
	if (!text) return false;
	const lower = text.toLowerCase();

	if (/\b(react|reaction|emoji)\b/.test(lower)) return true;
	if (/\w+'s\s+message\b/.test(lower)) return true;
	if (/message\s+(about|from|where)\b/.test(lower)) return true;
	if (/\bto\s+\w+'s\b/.test(lower)) return true;
	if (/\bthat\s+message\b/.test(lower)) return true;

	return false;
}

const emojiMap: Record<string, string> = {
	":thumbsup:": "👍",
	":thumbs_up:": "👍",
	":+1:": "👍",
	":thumbsdown:": "👎",
	":thumbs_down:": "👎",
	":-1:": "👎",
	":heart:": "❤️",
	":fire:": "🔥",
	":star:": "⭐",
	":check:": "✅",
	":white_check_mark:": "✅",
	":x:": "❌",
	":cross:": "❌",
	":smile:": "😄",
	":laughing:": "😆",
	":thinking:": "🤔",
	":eyes:": "👀",
	":clap:": "👏",
	":wave:": "👋",
	":ok:": "👌",
	":ok_hand:": "👌",
	":raised_hands:": "🙌",
	":pray:": "🙏",
	":100:": "💯",
	":rocket:": "🚀",
};

async function findUser(
	discordService: DiscordService,
	identifier: string,
	currentServerId?: string,
): Promise<User | null> {
	if (!discordService.client) return null;

	const cleanId = identifier.replace(/[<@!>]/g, "");

	if (/^\d+$/.test(cleanId)) {
		try {
			return await discordService.client.users.fetch(cleanId);
		} catch (_e) {
			// fall through to name search
		}
	}

	if (currentServerId) {
		const guild = await discordService.client.guilds.fetch(currentServerId);
		const members = await guild.members.fetch();
		const member = members.find(
			(m) =>
				m.user.username.toLowerCase() === identifier.toLowerCase() ||
				m.displayName.toLowerCase() === identifier.toLowerCase() ||
				m.user.tag.toLowerCase() === identifier.toLowerCase(),
		);
		if (member) return member.user;
	}

	const guilds = Array.from(discordService.client.guilds.cache.values());
	for (const guild of guilds) {
		const members = await guild.members.fetch();
		const member = members.find(
			(m) =>
				m.user.username.toLowerCase() === identifier.toLowerCase() ||
				m.displayName.toLowerCase() === identifier.toLowerCase() ||
				m.user.tag.toLowerCase() === identifier.toLowerCase(),
		);
		if (member) return member.user;
	}

	return null;
}

async function resolveOp(
	runtime: IAgentRuntime,
	state: State,
	options: HandlerOptions | undefined,
	messageText: string,
): Promise<DiscordMessageOp | null> {
	const parameters = getActionParameters(options);
	const optsOp =
		typeof parameters.op === "string" ? parameters.op.toLowerCase() : undefined;
	if (optsOp && (VALID_OPS as readonly string[]).includes(optsOp)) {
		return optsOp as DiscordMessageOp;
	}

	const lower = messageText.toLowerCase();
	if (/\bunpin\b/.test(lower)) return "unpin";
	if (/\bpin\b/.test(lower)) return "pin";
	if (/\b(react|reaction|emoji)\b/.test(lower)) return "react";
	if (/\b(edit|update message|change message)\b/.test(lower)) return "edit";
	if (/\b(delete|remove)\b.*\bmessage\b/.test(lower)) return "delete";
	if (/\b(dm|direct message)\b/.test(lower)) return "dm";
	if (/\breply\b/.test(lower)) return "reply";
	if (/\b(send|post)\b/.test(lower)) return "send";

	const prompt = composePromptFromState({ state, template: opRouterTemplate });
	for (let i = 0; i < 3; i++) {
		const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
		const parsed = parseJsonObjectFromText(response);
		const op =
			typeof parsed?.op === "string" ? parsed.op.toLowerCase() : undefined;
		if (op && (VALID_OPS as readonly string[]).includes(op)) {
			return op as DiscordMessageOp;
		}
	}
	return null;
}

async function handleSend(
	runtime: IAgentRuntime,
	message: Memory,
	state: State,
	options: HandlerOptions | undefined,
	callback: HandlerCallback | undefined,
): Promise<ActionResult | undefined> {
	const discordService = runtime.getService(
		DISCORD_SERVICE_NAME,
	) as DiscordService;
	if (!discordService?.client) {
		await callback?.({
			text: "Discord service is not available.",
			source: "discord",
		});
		return;
	}

	const prompt = composePromptFromState({
		state,
		template: sendMessageTemplate,
	});

	let messageInfo: { text: string; channelRef?: string } | null = null;
	const parameters = getActionParameters(options);
	if (parameters.text) {
		messageInfo = {
			text: String(parameters.text),
			channelRef: parameters.channelRef
				? String(parameters.channelRef)
				: "current",
		};
	}
	for (let i = 0; i < 3; i++) {
		if (messageInfo) break;
		const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
		const parsed = parseJsonObjectFromText(response);
		if (parsed?.text) {
			messageInfo = {
				text: String(parsed.text),
				channelRef: parsed.channelRef ? String(parsed.channelRef) : "current",
			};
			break;
		}
	}

	if (!messageInfo?.text) {
		runtime.logger.debug(
			{ src: "plugin:discord:action:message-op:send" },
			"Could not extract message info",
		);
		await callback?.({
			text: "I couldn't understand what message you want me to send. Please try again with a clearer request.",
			source: "discord",
		});
		return;
	}

	try {
		const stateData = state.data;
		const room = stateData?.room || (await runtime.getRoom(message.roomId));
		if (!room?.channelId) {
			await callback?.({
				text: "I couldn't determine the current channel.",
				source: "discord",
			});
			return;
		}

		let targetChannelId = room.channelId;
		if (messageInfo.channelRef && messageInfo.channelRef !== "current") {
			const guild = discordService.client.guilds.cache.first();
			if (guild) {
				const channels = await guild.channels.fetch();
				const targetChannel = channels.find((ch) => {
					if (!ch?.isTextBased()) return false;
					const channelName = ch.name?.toLowerCase() || "";
					const searchTerm = messageInfo?.channelRef?.toLowerCase() || "";
					return (
						channelName === searchTerm ||
						channelName.includes(searchTerm) ||
						ch.id === messageInfo?.channelRef
					);
				});
				if (targetChannel) targetChannelId = targetChannel.id;
			}
		}

		const channel = await discordService.client.channels.fetch(targetChannelId);
		if (!channel?.isTextBased()) {
			await callback?.({
				text: "I can only send messages to text channels.",
				source: "discord",
			});
			return;
		}

		const textChannel = channel as TextChannel;
		const sentMessage = await textChannel.send(messageInfo.text);

		await callback?.({
			text: "Message sent successfully.",
			source: message.content.source,
		});

		return {
			success: true,
			data: terminalActionResultData({
				op: "send",
				messageId: sentMessage.id,
				channelId: targetChannelId,
			}),
		};
	} catch (error) {
		runtime.logger.error(
			{
				src: "plugin:discord:action:message-op:send",
				agentId: runtime.agentId,
				error: error instanceof Error ? error.message : String(error),
			},
			"Error sending message",
		);
		await callback?.({
			text: "I encountered an error while trying to send the message. Please make sure I have the necessary permissions.",
			source: "discord",
		});
	}
}

async function handleDM(
	runtime: IAgentRuntime,
	message: Memory,
	state: State,
	options: HandlerOptions | undefined,
	callback: HandlerCallback | undefined,
): Promise<ActionResult | undefined> {
	const discordService = runtime.getService(
		DISCORD_SERVICE_NAME,
	) as DiscordService;
	if (!discordService?.client) {
		runtime.logger.error(
			{ src: "plugin:discord:action:message-op:dm", agentId: runtime.agentId },
			"Discord service not found or not initialized",
		);
		return { success: false, error: "Discord service is not available" };
	}

	const prompt = composePromptFromState({ state, template: sendDmTemplate });
	let dmInfo: { recipientIdentifier: string; messageContent: string } | null =
		null;
	const parameters = getActionParameters(options);
	if (parameters.recipientIdentifier && parameters.messageContent) {
		dmInfo = {
			recipientIdentifier: String(parameters.recipientIdentifier),
			messageContent: String(parameters.messageContent),
		};
	}
	for (let i = 0; i < 3; i++) {
		if (dmInfo) break;
		const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
		const parsed = parseJsonObjectFromText(response);
		if (parsed?.recipientIdentifier && parsed.messageContent) {
			dmInfo = {
				recipientIdentifier: String(parsed.recipientIdentifier),
				messageContent: String(parsed.messageContent),
			};
			break;
		}
	}

	if (!dmInfo) {
		runtime.logger.warn(
			{ src: "plugin:discord:action:message-op:dm", agentId: runtime.agentId },
			"Could not parse DM information from message",
		);
		await callback?.({
			text: "I couldn't understand who you want me to message or what to send. Please specify the recipient and the message content.",
			source: "discord",
		});
		return { success: false, error: "Could not parse DM information" };
	}

	try {
		const room = state.data?.room || (await runtime.getRoom(message.roomId));
		const currentServerId = room?.messageServerId;

		const targetUser = await findUser(
			discordService,
			dmInfo.recipientIdentifier,
			currentServerId,
		);
		if (!targetUser) {
			await callback?.({
				text: `I couldn't find a user with the identifier "${dmInfo.recipientIdentifier}". Please make sure the username or ID is correct.`,
				source: "discord",
			});
			return {
				success: false,
				error: `User not found: ${dmInfo.recipientIdentifier}`,
			};
		}

		if (targetUser.bot) {
			await callback?.({
				text: "I cannot send direct messages to other bots.",
				source: "discord",
			});
			return { success: false, error: "Cannot send DMs to bots" };
		}

		const dmChannel = await targetUser.createDM();
		await dmChannel.send(dmInfo.messageContent);

		const response: Content = {
			text: `I've sent your message to ${targetUser.username}: "${dmInfo.messageContent}"`,
			actions: ["DISCORD_MESSAGE_OP_RESPONSE"],
			source: message.content.source,
		};
		await callback?.(response);

		return {
			success: true,
			text: response.text,
			data: terminalActionResultData({ op: "dm" }),
		};
	} catch (error) {
		runtime.logger.error(
			{
				src: "plugin:discord:action:message-op:dm",
				agentId: runtime.agentId,
				error: error instanceof Error ? error.message : String(error),
			},
			"Error sending DM",
		);

		if (
			error instanceof Error &&
			error.message.includes("Cannot send messages to this user")
		) {
			await callback?.({
				text: "I couldn't send a message to that user. They may have DMs disabled or we don't share a server.",
				source: "discord",
			});
		} else {
			await callback?.({
				text: "I encountered an error while trying to send the direct message. Please make sure I have the necessary permissions.",
				source: "discord",
			});
		}
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function handleEdit(
	runtime: IAgentRuntime,
	message: Memory,
	state: State,
	options: HandlerOptions | undefined,
	callback: HandlerCallback | undefined,
): Promise<ActionResult | undefined> {
	const discordService = runtime.getService(
		DISCORD_SERVICE_NAME,
	) as DiscordService;
	if (!discordService?.client) {
		await callback?.({
			text: "Discord service is not available.",
			source: "discord",
		});
		return { success: false, error: "Discord service not available" };
	}

	const prompt = composePromptFromState({
		state,
		template: editMessageTemplate,
	});

	let editParams: {
		messageId: string;
		newText: string;
		channelRef?: string;
	} | null = null;
	const parameters = getActionParameters(options);
	if (
		typeof parameters.messageId === "string" &&
		typeof parameters.newText === "string"
	) {
		editParams = {
			messageId: parameters.messageId,
			newText: parameters.newText,
			channelRef:
				typeof parameters.channelRef === "string"
					? parameters.channelRef
					: undefined,
		};
	}

	for (let i = 0; i < 3; i++) {
		if (editParams) break;
		const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
		const parsed = parseJsonObjectFromText(response);
		if (
			parsed &&
			typeof parsed.messageId === "string" &&
			typeof parsed.newText === "string"
		) {
			editParams = {
				messageId: parsed.messageId,
				newText: parsed.newText,
				channelRef:
					typeof parsed.channelRef === "string" ? parsed.channelRef : undefined,
			};
			break;
		}
	}

	if (!editParams) {
		await callback?.({
			text: "I couldn't determine which message to edit or what to change it to.",
			source: "discord",
		});
		return { success: false, error: "Failed to extract edit parameters" };
	}

	try {
		let channel: TextChannel | null = null;
		if (editParams.channelRef === "current") {
			const channelId = message.content.channelId as string;
			if (channelId) {
				channel = discordService.client.channels.cache.get(
					channelId,
				) as TextChannel;
			}
		} else {
			channel = discordService.client.channels.cache.find(
				(c) =>
					c.id === editParams?.channelRef ||
					(c.isTextBased() && "name" in c && c.name === editParams?.channelRef),
			) as TextChannel;
		}

		if (!channel?.isTextBased()) {
			await callback?.({
				text: "I couldn't find the channel to edit the message in.",
				source: "discord",
			});
			return { success: false, error: "Channel not found" };
		}

		const targetMessage = (await channel.messages.fetch(
			editParams.messageId,
		)) as Message;
		if (!targetMessage) {
			await callback?.({
				text: "I couldn't find the message to edit.",
				source: "discord",
			});
			return { success: false, error: "Message not found" };
		}

		if (targetMessage.author.id !== discordService.client.user?.id) {
			await callback?.({
				text: "I can only edit my own messages.",
				source: "discord",
			});
			return {
				success: false,
				error: "Cannot edit messages from other users",
			};
		}

		await targetMessage.edit(editParams.newText);
		await callback?.({
			text: `I've edited the message to: "${editParams.newText}"`,
			source: "discord",
		});

		return {
			success: true,
			data: terminalActionResultData({
				op: "edit",
				messageId: editParams.messageId,
				channelId: channel.id,
				newText: editParams.newText,
			}),
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		await callback?.({
			text: `Failed to edit message: ${errorMessage}`,
			source: "discord",
		});
		return { success: false, error: errorMessage };
	}
}

async function handleDelete(
	runtime: IAgentRuntime,
	message: Memory,
	state: State,
	options: HandlerOptions | undefined,
	callback: HandlerCallback | undefined,
): Promise<ActionResult | undefined> {
	const discordService = runtime.getService(
		DISCORD_SERVICE_NAME,
	) as DiscordService;
	if (!discordService?.client) {
		await callback?.({
			text: "Discord service is not available.",
			source: "discord",
		});
		return { success: false, error: "Discord service not available" };
	}

	const prompt = composePromptFromState({
		state,
		template: deleteMessageTemplate,
	});

	let deleteParams: { messageId: string; channelRef?: string } | null = null;
	const parameters = getActionParameters(options);
	if (typeof parameters.messageId === "string") {
		deleteParams = {
			messageId: parameters.messageId,
			channelRef:
				typeof parameters.channelRef === "string"
					? parameters.channelRef
					: undefined,
		};
	}
	for (let i = 0; i < 3; i++) {
		if (deleteParams) break;
		const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
		const parsed = parseJsonObjectFromText(response);
		if (parsed && typeof parsed.messageId === "string") {
			deleteParams = {
				messageId: parsed.messageId,
				channelRef:
					typeof parsed.channelRef === "string" ? parsed.channelRef : undefined,
			};
			break;
		}
	}

	if (!deleteParams) {
		await callback?.({
			text: "I couldn't determine which message to delete.",
			source: "discord",
		});
		return { success: false, error: "Failed to extract delete parameters" };
	}

	try {
		let channel: TextChannel | null = null;
		if (deleteParams.channelRef === "current") {
			const channelId = message.content.channelId as string;
			if (channelId) {
				channel = discordService.client.channels.cache.get(
					channelId,
				) as TextChannel;
			}
		} else {
			channel = discordService.client.channels.cache.find(
				(c) =>
					c.id === deleteParams?.channelRef ||
					(c.isTextBased() &&
						"name" in c &&
						c.name === deleteParams?.channelRef),
			) as TextChannel;
		}

		if (!channel?.isTextBased()) {
			await callback?.({
				text: "I couldn't find the channel with that message.",
				source: "discord",
			});
			return { success: false, error: "Channel not found" };
		}

		const targetMessage = (await channel.messages.fetch(
			deleteParams.messageId,
		)) as Message;
		if (!targetMessage) {
			await callback?.({
				text: "I couldn't find the message to delete.",
				source: "discord",
			});
			return { success: false, error: "Message not found" };
		}

		const botUser = discordService.client.user;
		const hasManageMessages = botUser
			? (channel.permissionsFor(botUser)?.has("ManageMessages") ?? false)
			: false;
		const canDelete =
			targetMessage.author.id === botUser?.id || hasManageMessages;
		if (!canDelete) {
			await callback?.({
				text: "I don't have permission to delete that message.",
				source: "discord",
			});
			return { success: false, error: "No permission to delete message" };
		}

		await targetMessage.delete();
		await callback?.({ text: "I've deleted the message.", source: "discord" });

		return {
			success: true,
			data: terminalActionResultData({
				op: "delete",
				messageId: deleteParams.messageId,
				channelId: channel.id,
			}),
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		await callback?.({
			text: `Failed to delete message: ${errorMessage}`,
			source: "discord",
		});
		return { success: false, error: errorMessage };
	}
}

async function handleReact(
	runtime: IAgentRuntime,
	message: Memory,
	state: State,
	options: HandlerOptions | undefined,
	callback: HandlerCallback | undefined,
): Promise<ActionResult | undefined> {
	const discordService = runtime.getService(
		DISCORD_SERVICE_NAME,
	) as DiscordService;
	if (!discordService?.client) {
		await callback?.({
			text: "Discord service is not available.",
			source: "discord",
		});
		return;
	}

	let reactionInfo: { messageRef: string; emoji: string } | null = null;
	const parameters = getActionParameters(options);
	if (parameters.emoji) {
		reactionInfo = {
			messageRef: parameters.messageRef
				? String(parameters.messageRef)
				: "last",
			emoji: String(parameters.emoji),
		};
	}
	const userText = message.content?.text || "";
	const needsLLM = isExplicitReactionRequest(userText);

	if (!reactionInfo && !needsLLM) {
		const stateData = state.data as Record<string, unknown> | undefined;
		const stateWithResponseText = state as State & { responseText?: string };
		const responseText = String(
			stateData?.responseText ||
				stateData?.text ||
				stateWithResponseText.responseText ||
				"",
		);

		if (responseText) {
			const emojis = extractEmojisFromText(responseText);
			if (emojis.length > 0) {
				reactionInfo = { messageRef: "last", emoji: emojis[0] };
			}
		}

		if (!reactionInfo) {
			const recentMessages = (state.data?.recentMessages || []) as Memory[];
			const agentLastMessage = recentMessages
				.filter((m) => m.entityId === runtime.agentId)
				.pop();
			const agentLastMessageContent = agentLastMessage?.content;
			if (agentLastMessageContent?.text) {
				const emojis = extractEmojisFromText(agentLastMessageContent.text);
				if (emojis.length > 0) {
					reactionInfo = { messageRef: "last", emoji: emojis[0] };
				}
			}
		}
	}

	if (!reactionInfo) {
		const prompt = composePromptFromState({
			state,
			template: reactToMessageTemplate,
		});

		for (let i = 0; i < 3; i++) {
			const response = await runtime.useModel(ModelType.TEXT_SMALL, {
				prompt,
			});
			const parsed = parseJsonObjectFromText(response);
			if (parsed?.emoji) {
				reactionInfo = {
					messageRef: String(parsed.messageRef || "last"),
					emoji: String(parsed.emoji),
				};
				break;
			}
		}
	}

	if (!reactionInfo) {
		runtime.logger.debug(
			{ src: "plugin:discord:action:message-op:react" },
			"Could not extract reaction info",
		);
		if (needsLLM) {
			await callback?.({
				text: "I couldn't understand which message to react to or what emoji to use. Try being more specific, like 'react with 👍 to the last message'.",
				source: "discord",
			});
		}
		return;
	}

	try {
		const room = state.data?.room || (await runtime.getRoom(message.roomId));
		if (!room?.channelId) {
			await callback?.({
				text: "I couldn't determine the current channel.",
				source: "discord",
			});
			return;
		}

		const channel = await discordService.client.channels.fetch(room.channelId);
		if (!channel?.isTextBased()) {
			await callback?.({
				text: "I can only react to messages in text channels.",
				source: "discord",
			});
			return;
		}

		const textChannel = channel as TextChannel;
		let targetMessage: Message | null = null;

		if (
			reactionInfo.messageRef === "last" ||
			reactionInfo.messageRef === "previous"
		) {
			const messages = await textChannel.messages.fetch({ limit: 100 });
			const sortedMessages = Array.from(messages.values()).sort(
				(a, b) => b.createdTimestamp - a.createdTimestamp,
			);
			const clientUser = discordService.client.user;
			targetMessage =
				sortedMessages.find(
					(msg) =>
						msg.id !== message.content.id && msg.author.id !== clientUser?.id,
				) || null;
		} else if (/^\d+$/.test(reactionInfo.messageRef)) {
			try {
				targetMessage = await textChannel.messages.fetch(
					reactionInfo.messageRef,
				);
			} catch (_e) {
				// not found
			}
		} else {
			const messages = await textChannel.messages.fetch({ limit: 100 });
			const searchLower = reactionInfo.messageRef.toLowerCase();
			targetMessage =
				Array.from(messages.values()).find((msg) => {
					const contentMatch = msg.content.toLowerCase().includes(searchLower);
					const authorMatch = msg.author.username
						.toLowerCase()
						.includes(searchLower);
					return contentMatch || authorMatch;
				}) || null;
		}

		if (!targetMessage) {
			await callback?.({
				text: "I couldn't find the message you want me to react to. Try being more specific or use 'last message'.",
				source: "discord",
			});
			return;
		}

		let emoji = reactionInfo.emoji;
		if (!/\p{Emoji}/u.test(emoji)) {
			const mapped = emojiMap[emoji.toLowerCase()];
			if (mapped) {
				emoji = mapped;
			} else if (!/<a?:\w+:\d+>/.test(emoji)) {
				emoji = emoji.replace(/:/g, "");
			}
		}

		await targetMessage.react(emoji);
		await callback?.({
			text: `I've added a ${emoji} reaction to the message.`,
			source: message.content.source,
		});
		return {
			success: true,
			data: terminalActionResultData({ op: "react" }),
		};
	} catch (error) {
		runtime.logger.error(
			{
				src: "plugin:discord:action:message-op:react",
				agentId: runtime.agentId,
				error: error instanceof Error ? error.message : String(error),
			},
			"Error in react to message",
		);
		await callback?.({
			text: "I encountered an error while trying to react to the message. Please make sure I have the necessary permissions.",
			source: "discord",
		});
	}
}

async function handlePin(
	runtime: IAgentRuntime,
	message: Memory,
	state: State,
	options: HandlerOptions | undefined,
	callback: HandlerCallback | undefined,
): Promise<ActionResult | undefined> {
	const discordService = runtime.getService(
		DISCORD_SERVICE_NAME,
	) as DiscordService;
	if (!discordService?.client) {
		await callback?.({
			text: "Discord service is not available.",
			source: "discord",
		});
		return;
	}

	const prompt = composePromptFromState({
		state,
		template: pinMessageTemplate,
	});

	let messageInfo: { messageRef: string } | null = null;
	const parameters = getActionParameters(options);
	if (parameters.messageRef) {
		messageInfo = { messageRef: String(parameters.messageRef) };
	}
	for (let i = 0; i < 3; i++) {
		if (messageInfo) break;
		const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
		const parsed = parseJsonObjectFromText(response);
		if (parsed?.messageRef) {
			messageInfo = { messageRef: String(parsed.messageRef) };
			break;
		}
	}

	if (!messageInfo) {
		await callback?.({
			text: "I couldn't understand which message you want to pin. Please be more specific.",
			source: "discord",
		});
		return;
	}

	try {
		const room = state.data?.room || (await runtime.getRoom(message.roomId));
		if (!room?.channelId) {
			await callback?.({
				text: "I couldn't determine the current channel.",
				source: "discord",
			});
			return;
		}

		const channel = await discordService.client.channels.fetch(room.channelId);
		if (!channel?.isTextBased()) {
			await callback?.({
				text: "I can only pin messages in text channels.",
				source: "discord",
			});
			return;
		}

		const textChannel = channel as TextChannel;
		const botMember = textChannel.guild?.members.cache.get(
			discordService.client.user?.id,
		);
		if (botMember) {
			const permissions = textChannel.permissionsFor(botMember);
			if (!permissions?.has(PermissionsBitField.Flags.ManageMessages)) {
				await callback?.({
					text: "I don't have permission to pin messages in this channel. I need the 'Manage Messages' permission.",
					source: "discord",
				});
				return;
			}
		}

		let targetMessage: Message | null = null;
		if (
			messageInfo.messageRef === "last" ||
			messageInfo.messageRef === "previous"
		) {
			const messages = await textChannel.messages.fetch({ limit: 100 });
			const sortedMessages = Array.from(messages.values()).sort(
				(a, b) => b.createdTimestamp - a.createdTimestamp,
			);
			const clientUser = discordService.client.user;
			targetMessage =
				sortedMessages.find(
					(msg) =>
						msg.id !== message.content.id && msg.author.id !== clientUser?.id,
				) || null;
		} else if (/^\d+$/.test(messageInfo.messageRef)) {
			try {
				targetMessage = await textChannel.messages.fetch(
					messageInfo.messageRef,
				);
			} catch (_e) {
				// not found
			}
		} else {
			const messages = await textChannel.messages.fetch({ limit: 100 });
			const searchLower = messageInfo.messageRef.toLowerCase();
			targetMessage =
				Array.from(messages.values()).find((msg) => {
					const contentMatch = msg.content.toLowerCase().includes(searchLower);
					const authorMatch = msg.author.username
						.toLowerCase()
						.includes(searchLower);
					return contentMatch || authorMatch;
				}) || null;
		}

		if (!targetMessage) {
			await callback?.({
				text: "I couldn't find the message you want to pin. Try being more specific or use 'last message'.",
				source: "discord",
			});
			return;
		}

		if (targetMessage.pinned) {
			await callback?.({
				text: "That message is already pinned.",
				source: "discord",
			});
			return;
		}

		await targetMessage.pin();
		await callback?.({
			text: `I've pinned the message from ${targetMessage.author.username}.`,
			source: message.content.source,
		});
		return { success: true, data: terminalActionResultData({ op: "pin" }) };
	} catch (error) {
		runtime.logger.error(
			{
				src: "plugin:discord:action:message-op:pin",
				agentId: runtime.agentId,
				error: error instanceof Error ? error.message : String(error),
			},
			"Error pinning message",
		);
		await callback?.({
			text: "I encountered an error while trying to pin the message. Please make sure I have the necessary permissions.",
			source: "discord",
		});
	}
}

async function handleUnpin(
	runtime: IAgentRuntime,
	message: Memory,
	state: State,
	options: HandlerOptions | undefined,
	callback: HandlerCallback | undefined,
): Promise<ActionResult | undefined> {
	const discordService = runtime.getService(
		DISCORD_SERVICE_NAME,
	) as DiscordService;
	if (!discordService?.client) {
		await callback?.({
			text: "Discord service is not available.",
			source: "discord",
		});
		return { success: false, error: "Discord service is not available" };
	}

	const prompt = composePromptFromState({
		state,
		template: unpinMessageTemplate,
	});

	let messageInfo: { messageRef: string } | null = null;
	const parameters = getActionParameters(options);
	if (parameters.messageRef) {
		messageInfo = { messageRef: String(parameters.messageRef) };
	}
	for (let i = 0; i < 3; i++) {
		if (messageInfo) break;
		const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
		const parsed = parseJsonObjectFromText(response);
		if (parsed?.messageRef) {
			messageInfo = { messageRef: String(parsed.messageRef) };
			break;
		}
	}

	if (!messageInfo) {
		await callback?.({
			text: "I couldn't understand which message you want to unpin. Please be more specific.",
			source: "discord",
		});
		return { success: false, error: "Could not parse message reference" };
	}

	try {
		const room = state.data?.room || (await runtime.getRoom(message.roomId));
		if (!room?.channelId) {
			await callback?.({
				text: "I couldn't determine the current channel.",
				source: "discord",
			});
			return { success: false, error: "Could not determine current channel" };
		}

		const channel = await discordService.client.channels.fetch(room.channelId);
		if (!channel?.isTextBased()) {
			await callback?.({
				text: "I can only unpin messages in text channels.",
				source: "discord",
			});
			return { success: false, error: "Channel is not a text channel" };
		}

		const textChannel = channel as TextChannel;
		const clientUser = discordService.client.user;
		const botMember = textChannel.guild?.members.cache.get(clientUser?.id);
		if (botMember) {
			const permissions = textChannel.permissionsFor(botMember);
			if (
				permissions &&
				!permissions.has(PermissionsBitField.Flags.ManageMessages)
			) {
				await callback?.({
					text: "I don't have permission to unpin messages in this channel. I need the 'Manage Messages' permission.",
					source: "discord",
				});
				return { success: false, error: "Missing ManageMessages permission" };
			}
		}

		const pinnedMessages = await textChannel.messages.fetchPinned();
		if (pinnedMessages.size === 0) {
			await callback?.({
				text: "There are no pinned messages in this channel.",
				source: "discord",
			});
			return {
				success: true,
				text: "No pinned messages in channel",
				data: terminalActionResultData({ op: "unpin" }),
			};
		}

		let targetMessage: Message | null = null;
		if (
			messageInfo.messageRef === "last_pinned" ||
			messageInfo.messageRef === "last"
		) {
			targetMessage = Array.from(pinnedMessages.values()).sort(
				(a, b) => b.createdTimestamp - a.createdTimestamp,
			)[0];
		} else if (/^\d+$/.test(messageInfo.messageRef)) {
			targetMessage = pinnedMessages.get(messageInfo.messageRef) || null;
		} else {
			const searchLower = messageInfo.messageRef.toLowerCase();
			targetMessage =
				Array.from(pinnedMessages.values()).find((msg) => {
					const contentMatch = msg.content.toLowerCase().includes(searchLower);
					const authorMatch = msg.author.username
						.toLowerCase()
						.includes(searchLower);
					return contentMatch || authorMatch;
				}) || null;
		}

		if (!targetMessage) {
			await callback?.({
				text: "I couldn't find a pinned message matching your description.",
				source: "discord",
			});
			return {
				success: false,
				error: "Could not find matching pinned message",
			};
		}

		await targetMessage.unpin();
		const response: Content = {
			text: `I've unpinned the message from ${targetMessage.author.username}.`,
			source: message.content.source,
		};
		await callback?.(response);
		return {
			success: true,
			text: response.text,
			data: terminalActionResultData({ op: "unpin" }),
		};
	} catch (error) {
		runtime.logger.error(
			{
				src: "plugin:discord:action:message-op:unpin",
				agentId: runtime.agentId,
				error: error instanceof Error ? error.message : String(error),
			},
			"Error unpinning message",
		);
		await callback?.({
			text: "I encountered an error while trying to unpin the message. Please make sure I have the necessary permissions.",
			source: "discord",
		});
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

const spec = requireActionSpec("DISCORD_MESSAGE_OP");

export const messageOp: Action = {
	name: spec.name,
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,
	descriptionCompressed: spec.descriptionCompressed,
	contexts: ["messaging", "connectors"],
	contextGate: { anyOf: ["messaging", "connectors"] },
	roleGate: { minRole: "USER" },
	parameters: [
		{
			name: "op",
			description:
				"Operation: send, reply, dm, edit, delete, react, pin, or unpin.",
			required: false,
			schema: {
				type: "string",
				enum: [
					"send",
					"reply",
					"dm",
					"edit",
					"delete",
					"react",
					"pin",
					"unpin",
				],
			},
		},
		{
			name: "messageContent",
			description: "Message text for send, reply, dm, or edit.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "channelIdentifier",
			description: "Discord channel name/id or current channel.",
			required: false,
			schema: { type: "string", default: "current" },
		},
		{
			name: "targetUser",
			description: "Discord user id, mention, or username for a DM.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "messageRef",
			description: "Message id, last/previous marker, or search text.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "emoji",
			description: "Reaction emoji.",
			required: false,
			schema: { type: "string" },
		},
	],
	...terminalActionInteractionSemantics,
	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<boolean> => {
		return message.content.source === "discord";
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult | undefined> => {
		const currentState = state ?? (await runtime.composeState(message));
		const userText =
			typeof message.content.text === "string" ? message.content.text : "";

		const op = await resolveOp(runtime, currentState, options, userText);
		if (!op) {
			await callback?.({
				text: "I couldn't determine which Discord message operation to run.",
				source: "discord",
			});
			return { success: false, error: "Could not resolve message op" };
		}

		switch (op) {
			case "send":
			case "reply":
				return handleSend(runtime, message, currentState, options, callback);
			case "dm":
				return handleDM(runtime, message, currentState, options, callback);
			case "edit":
				return handleEdit(runtime, message, currentState, options, callback);
			case "delete":
				return handleDelete(runtime, message, currentState, options, callback);
			case "react":
				return handleReact(runtime, message, currentState, options, callback);
			case "pin":
				return handlePin(runtime, message, currentState, options, callback);
			case "unpin":
				return handleUnpin(runtime, message, currentState, options, callback);
		}
	},
	examples: (spec.examples ?? []) as ActionExample[][],
};

export default messageOp;
