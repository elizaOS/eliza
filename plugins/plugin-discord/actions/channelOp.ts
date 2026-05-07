import {
	type Action,
	type ActionExample,
	type ActionResult,
	type Content,
	composePromptFromState,
	createUniqueUuid,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	type Memory,
	MemoryType,
	ModelType,
	type State,
} from "@elizaos/core";
import {
	type BaseGuildVoiceChannel,
	type Collection,
	ChannelType as DiscordChannelType,
	type Message,
	PermissionsBitField,
	type TextChannel,
} from "discord.js";
import { DISCORD_SERVICE_NAME } from "../constants";
import {
	channelInfoTemplate,
	joinChannelTemplate,
	leaveChannelTemplate,
	searchMessagesTemplate,
} from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import type { DiscordService } from "../service";
import { getActionParameters, parseJsonObjectFromText } from "../utils";
import type { VoiceManager } from "../voice";
import {
	terminalActionInteractionSemantics,
	terminalActionResultData,
} from "./actionResultSemantics";

type DiscordChannelOp = "join" | "leave" | "read" | "search";

const VALID_OPS: readonly DiscordChannelOp[] = [
	"join",
	"leave",
	"read",
	"search",
];

const opRouterTemplate = `Pick the Discord channel operation that matches the user's request.

Recent conversation:
{{recentMessages}}

Allowed values for "op":
- join: join (start listening to) a Discord text channel, or join a voice channel
- leave: leave (stop listening to) a Discord text channel, or leave a voice channel
- read: read or summarize recent messages in a Discord channel
- search: search messages in a Discord channel

Respond with JSON only, no markdown:
{"op":"join"}`;

async function resolveOp(
	runtime: IAgentRuntime,
	state: State,
	options: HandlerOptions | undefined,
	messageText: string,
): Promise<DiscordChannelOp | null> {
	const parameters = getActionParameters(options);
	const optsOp =
		typeof parameters.op === "string" ? parameters.op.toLowerCase() : undefined;
	if (optsOp && (VALID_OPS as readonly string[]).includes(optsOp)) {
		return optsOp as DiscordChannelOp;
	}

	const lower = messageText.toLowerCase();
	if (/\b(search|find)\b.*\bmessages?\b/.test(lower)) return "search";
	if (/\bsearch\b/.test(lower)) return "search";
	if (/\b(leave|stop\s+listening|disconnect)\b/.test(lower)) return "leave";
	if (/\b(join|start\s+listening|hop\s+in)\b/.test(lower)) return "join";
	if (
		/\b(read|show|summarize|catch\s*up|recap)\b.*\b(channel|messages?)\b/.test(
			lower,
		)
	) {
		return "read";
	}
	if (/\b(read|show)\b/.test(lower)) return "read";

	const prompt = composePromptFromState({ state, template: opRouterTemplate });
	for (let i = 0; i < 3; i++) {
		const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
		const parsed = parseJsonObjectFromText(response);
		const op =
			typeof parsed?.op === "string" ? parsed.op.toLowerCase() : undefined;
		if (op && (VALID_OPS as readonly string[]).includes(op)) {
			return op as DiscordChannelOp;
		}
	}
	return null;
}

async function findChannel(
	discordService: DiscordService,
	identifier: string,
	currentServerId: string | undefined,
	isVoiceChannel: boolean,
	currentChannelId?: string,
): Promise<TextChannel | BaseGuildVoiceChannel | null> {
	if (!discordService.client) return null;

	if (identifier === "current" && currentChannelId) {
		try {
			const channel =
				await discordService.client.channels.fetch(currentChannelId);
			if (isVoiceChannel && channel?.type === DiscordChannelType.GuildVoice) {
				return channel as BaseGuildVoiceChannel;
			}
			if (
				!isVoiceChannel &&
				channel?.isTextBased() &&
				!channel.isVoiceBased()
			) {
				return channel as TextChannel;
			}
		} catch (_e) {
			// fall through
		}
	}

	const cleanId = identifier.replace(/[<#>]/g, "");

	if (/^\d+$/.test(cleanId)) {
		try {
			const channel = await discordService.client.channels.fetch(cleanId);
			if (isVoiceChannel && channel?.type === DiscordChannelType.GuildVoice) {
				return channel as BaseGuildVoiceChannel;
			}
			if (
				!isVoiceChannel &&
				channel?.isTextBased() &&
				!channel.isVoiceBased()
			) {
				return channel as TextChannel;
			}
		} catch (_e) {
			// fall through to name search
		}
	}

	const matchByName = (ch: {
		name?: string | null;
		type?: number;
		isTextBased?: () => boolean;
		isVoiceBased?: () => boolean;
	}) => {
		const nameLower = ch?.name?.toLowerCase() ?? "";
		const idLower = identifier.toLowerCase();
		const stripped = (s: string) => s.replace(/[^a-z0-9 ]/g, "");
		const nameMatch =
			nameLower === idLower || stripped(nameLower) === stripped(idLower);
		if (!nameMatch) return false;
		if (isVoiceChannel) return ch.type === DiscordChannelType.GuildVoice;
		return Boolean(ch.isTextBased?.()) && !ch.isVoiceBased?.();
	};

	if (currentServerId) {
		try {
			const guild = await discordService.client.guilds.fetch(currentServerId);
			const channels = await guild.channels.fetch();
			const channel = channels.find((ch) => ch && matchByName(ch));
			if (channel) return channel as TextChannel | BaseGuildVoiceChannel;
		} catch (_e) {
			// continue
		}
	}

	for (const guild of discordService.client.guilds.cache.values()) {
		try {
			const channels = await guild.channels.fetch();
			const channel = channels.find((ch) => ch && matchByName(ch));
			if (channel) return channel as TextChannel | BaseGuildVoiceChannel;
		} catch (_e) {
			// continue
		}
	}

	return null;
}

async function handleJoin(
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
		template: joinChannelTemplate,
	});
	let channelInfo: {
		channelIdentifier: string;
		isVoiceChannel: boolean;
	} | null = null;
	const parameters = getActionParameters(options);
	if (parameters.channelIdentifier) {
		channelInfo = {
			channelIdentifier: String(parameters.channelIdentifier),
			isVoiceChannel:
				parameters.isVoiceChannel === true ||
				String(parameters.isVoiceChannel).toLowerCase() === "true",
		};
	}
	for (let i = 0; i < 3; i++) {
		if (channelInfo) break;
		const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
		const parsed = parseJsonObjectFromText(response);
		if (parsed?.channelIdentifier) {
			channelInfo = {
				channelIdentifier: String(parsed.channelIdentifier),
				isVoiceChannel:
					parsed.isVoiceChannel === true ||
					String(parsed.isVoiceChannel).toLowerCase() === "true",
			};
			break;
		}
	}
	if (!channelInfo) {
		await callback?.({
			text: "I couldn't understand which channel you want me to join. Please specify the channel name or ID.",
			source: "discord",
		});
		return { success: false, error: "Could not parse channel information" };
	}

	const room = state.data?.room || (await runtime.getRoom(message.roomId));
	const currentServerId = room?.messageServerId;

	const messageContentText = message.content.text;
	const messageText = messageContentText?.toLowerCase() || "";
	const isVoiceRequest =
		channelInfo.isVoiceChannel ||
		messageText.includes("voice") ||
		messageText.includes("vc") ||
		messageText.includes("hop in");

	let targetChannel = await findChannel(
		discordService,
		channelInfo.channelIdentifier,
		currentServerId,
		isVoiceRequest,
	);
	if (!targetChannel) {
		targetChannel = await findChannel(
			discordService,
			channelInfo.channelIdentifier,
			currentServerId,
			!isVoiceRequest,
		);
	}

	if (!targetChannel && isVoiceRequest && currentServerId) {
		const guild = discordService.client.guilds.cache.get(currentServerId);
		const member = guild?.members?.cache?.find(
			(m) => createUniqueUuid(runtime, m.id) === message.entityId,
		);
		if (member?.voice?.channel) {
			targetChannel = member.voice.channel as BaseGuildVoiceChannel;
		}
	}

	if (!targetChannel) {
		await callback?.({
			text: `I couldn't find a channel with the identifier "${channelInfo.channelIdentifier}". Please make sure the channel name or ID is correct and I have access to it.`,
			source: "discord",
		});
		return {
			success: false,
			error: `Channel not found: ${channelInfo.channelIdentifier}`,
		};
	}

	if (targetChannel.type === DiscordChannelType.GuildVoice) {
		const voiceChannel = targetChannel as BaseGuildVoiceChannel;
		const voiceManager = discordService.voiceManager as VoiceManager;
		if (!voiceManager) {
			await callback?.({
				text: "Voice functionality is not available at the moment.",
				source: "discord",
			});
			return { success: false, error: "Voice functionality not available" };
		}
		await voiceManager.joinChannel(voiceChannel);
		await runtime.createMemory(
			{
				entityId: message.entityId,
				agentId: message.agentId,
				roomId: message.roomId,
				content: {
					source: "discord",
					thought: `I joined the voice channel ${voiceChannel.name}`,
					actions: ["JOIN_VOICE_STARTED"],
				},
				metadata: { type: MemoryType.CUSTOM },
			},
			"messages",
		);
		const response: Content = {
			text: `I've joined the voice channel ${voiceChannel.name}!`,
			actions: ["DISCORD_CHANNEL_OP_RESPONSE"],
			source: message.content.source,
		};
		await callback?.(response);
		return {
			success: true,
			text: response.text,
			data: terminalActionResultData({ op: "join" }),
		};
	}

	const textChannel = targetChannel as TextChannel;
	const currentChannels = discordService.getAllowedChannels();
	if (currentChannels.includes(textChannel.id)) {
		await callback?.({
			text: `I'm already listening to ${textChannel.name} (<#${textChannel.id}>).`,
			source: "discord",
		});
		return {
			success: true,
			text: `Already listening to ${textChannel.name}`,
			data: terminalActionResultData({ op: "join" }),
		};
	}
	const success = discordService.addAllowedChannel(textChannel.id);
	if (!success) {
		await callback?.({
			text: `I couldn't add ${textChannel.name} to my listening list. Please try again.`,
			source: "discord",
		});
		return {
			success: false,
			error: `Could not add ${textChannel.name} to listening list`,
		};
	}
	const response: Content = {
		text: `I've started listening to ${textChannel.name} (<#${textChannel.id}>). I'll now respond to messages in that channel.`,
		actions: ["DISCORD_CHANNEL_OP_RESPONSE"],
		source: message.content.source,
	};
	await callback?.(response);
	return {
		success: true,
		text: response.text,
		data: terminalActionResultData({ op: "join" }),
	};
}

async function handleLeave(
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
		template: leaveChannelTemplate,
	});
	let channelInfo: {
		channelIdentifier: string;
		isVoiceChannel: boolean;
	} | null = null;
	const parameters = getActionParameters(options);
	if (parameters.channelIdentifier) {
		channelInfo = {
			channelIdentifier: String(parameters.channelIdentifier),
			isVoiceChannel:
				parameters.isVoiceChannel === true ||
				String(parameters.isVoiceChannel).toLowerCase() === "true",
		};
	}
	for (let i = 0; i < 3; i++) {
		if (channelInfo) break;
		const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
		const parsed = parseJsonObjectFromText(response);
		if (parsed?.channelIdentifier) {
			channelInfo = {
				channelIdentifier: String(parsed.channelIdentifier),
				isVoiceChannel:
					parsed.isVoiceChannel === true ||
					String(parsed.isVoiceChannel).toLowerCase() === "true",
			};
			break;
		}
	}

	const room = state.data?.room || (await runtime.getRoom(message.roomId));
	const currentServerId = room?.messageServerId;
	const currentChannelId = room?.channelId;

	const messageContentText = message.content.text;
	const messageText = messageContentText?.toLowerCase() || "";
	const isVoiceRequest =
		channelInfo?.isVoiceChannel ||
		messageText.includes("voice") ||
		messageText.includes("vc") ||
		messageText.includes("call");

	if (
		isVoiceRequest &&
		(!channelInfo || channelInfo.channelIdentifier === "current")
	) {
		const voiceManager = discordService.voiceManager as VoiceManager;
		if (!voiceManager) {
			await callback?.({
				text: "Voice functionality is not available at the moment.",
				source: "discord",
			});
			return {
				success: false,
				error: "Voice functionality not available",
			};
		}
		if (currentServerId) {
			const guild = discordService.client.guilds.cache.get(currentServerId);
			const voiceChannel = guild?.members?.me?.voice?.channel;
			if (
				!voiceChannel ||
				voiceChannel.type !== DiscordChannelType.GuildVoice
			) {
				await callback?.({
					text: "I'm not currently in a voice channel.",
					source: "discord",
				});
				return { success: false, error: "Not in a voice channel" };
			}
			const baseVoiceChannel = voiceChannel as BaseGuildVoiceChannel;
			const connection = voiceManager.getVoiceConnection(guild.id);
			if (!connection) {
				await callback?.({
					text: "No active voice connection found.",
					source: "discord",
				});
				return { success: false, error: "No active voice connection" };
			}
			voiceManager.leaveChannel(baseVoiceChannel);
			await runtime.createMemory(
				{
					entityId: message.entityId,
					agentId: message.agentId,
					roomId: createUniqueUuid(runtime, baseVoiceChannel.id),
					content: {
						source: "discord",
						thought: `I left the voice channel ${baseVoiceChannel.name}`,
						actions: ["LEAVE_VOICE_STARTED"],
					},
					metadata: { type: MemoryType.CUSTOM },
				},
				"messages",
			);
			await callback?.({
				text: `I've left the voice channel ${baseVoiceChannel.name}.`,
				source: "discord",
			});
			return {
				success: true,
				data: terminalActionResultData({ op: "leave" }),
			};
		}
	}

	if (!channelInfo) {
		await callback?.({
			text: "I couldn't understand which channel you want me to leave. Please specify the channel name or ID.",
			source: "discord",
		});
		return { success: false, error: "Could not parse channel information" };
	}

	let targetChannel = await findChannel(
		discordService,
		channelInfo.channelIdentifier,
		currentServerId,
		Boolean(isVoiceRequest),
		currentChannelId,
	);
	if (!targetChannel) {
		targetChannel = await findChannel(
			discordService,
			channelInfo.channelIdentifier,
			currentServerId,
			!isVoiceRequest,
			currentChannelId,
		);
	}
	if (!targetChannel) {
		await callback?.({
			text: `I couldn't find a channel with the identifier "${channelInfo.channelIdentifier}". Please make sure the channel name or ID is correct.`,
			source: "discord",
		});
		return { success: false, error: "Channel not found" };
	}

	if (targetChannel.type === DiscordChannelType.GuildVoice) {
		const voiceChannel = targetChannel as BaseGuildVoiceChannel;
		const voiceManager = discordService.voiceManager as VoiceManager;
		if (!voiceManager) {
			await callback?.({
				text: "Voice functionality is not available at the moment.",
				source: "discord",
			});
			return {
				success: false,
				error: "Voice functionality not available",
			};
		}
		const guild = voiceChannel.guild;
		const currentVoiceChannel = guild.members?.me?.voice?.channel;
		if (!currentVoiceChannel || currentVoiceChannel.id !== voiceChannel.id) {
			await callback?.({
				text: `I'm not currently in the voice channel ${voiceChannel.name}.`,
				source: "discord",
			});
			return {
				success: false,
				error: `Not currently in voice channel ${voiceChannel.name}`,
			};
		}
		voiceManager.leaveChannel(voiceChannel);
		await runtime.createMemory(
			{
				entityId: message.entityId,
				agentId: message.agentId,
				roomId: createUniqueUuid(runtime, voiceChannel.id),
				content: {
					source: "discord",
					thought: `I left the voice channel ${voiceChannel.name}`,
					actions: ["LEAVE_VOICE_STARTED"],
				},
				metadata: { type: MemoryType.CUSTOM },
			},
			"messages",
		);
		const response: Content = {
			text: `I've left the voice channel ${voiceChannel.name}.`,
			actions: ["DISCORD_CHANNEL_OP_RESPONSE"],
			source: message.content.source,
		};
		await callback?.(response);
		return {
			success: true,
			text: response.text,
			data: terminalActionResultData({ op: "leave" }),
		};
	}

	const textChannel = targetChannel as TextChannel;
	const currentChannels = discordService.getAllowedChannels();
	if (!currentChannels.includes(textChannel.id)) {
		await callback?.({
			text: `I'm not currently listening to ${textChannel.name} (<#${textChannel.id}>).`,
			source: "discord",
		});
		return {
			success: false,
			error: `Not listening to ${textChannel.name}`,
		};
	}
	const success = discordService.removeAllowedChannel(textChannel.id);
	if (!success) {
		await callback?.({
			text: `I couldn't remove ${textChannel.name} from my listening list. This channel might be configured in my environment settings and cannot be removed dynamically.`,
			source: "discord",
		});
		return {
			success: false,
			error: `Could not remove ${textChannel.name} from listening list`,
		};
	}
	const response: Content = {
		text: `I've stopped listening to ${textChannel.name} (<#${textChannel.id}>). I will no longer respond to messages in that channel.`,
		actions: ["DISCORD_CHANNEL_OP_RESPONSE"],
		source: message.content.source,
	};
	await callback?.(response);
	return {
		success: true,
		text: response.text,
		data: terminalActionResultData({ op: "leave" }),
	};
}

async function resolveTargetTextChannel(
	discordService: DiscordService,
	identifier: string,
	roomChannelId: string | undefined,
	roomServerId: string | undefined,
): Promise<TextChannel | null> {
	if (!discordService.client) return null;
	if (
		identifier === "current" ||
		identifier === "this" ||
		identifier === "here"
	) {
		if (!roomChannelId) return null;
		try {
			const channel = await discordService.client.channels.fetch(roomChannelId);
			if (channel?.isTextBased()) return channel as TextChannel;
		} catch (_e) {
			return null;
		}
		return null;
	}
	if (/^\d+$/.test(identifier)) {
		try {
			const channel = await discordService.client.channels.fetch(identifier);
			if (channel?.isTextBased()) return channel as TextChannel;
		} catch (_e) {
			return null;
		}
		return null;
	}
	if (!roomServerId) return null;
	try {
		const guild = await discordService.client.guilds.fetch(roomServerId);
		const channels = await guild.channels.fetch();
		const found = channels.find(
			(c) =>
				c?.isTextBased() &&
				c.name.toLowerCase().includes(identifier.toLowerCase()),
		);
		return (found as TextChannel) || null;
	} catch (_e) {
		return null;
	}
}

async function handleRead(
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
		template: channelInfoTemplate,
	});
	let channelInfo: {
		channelIdentifier: string;
		messageCount: number;
		summarize: boolean;
		focusUser: string | null;
	} | null = null;
	const parameters = getActionParameters(options);
	if (parameters.channelIdentifier) {
		channelInfo = {
			channelIdentifier: String(parameters.channelIdentifier),
			messageCount: Math.min(
				Math.max(Number(parameters.messageCount) || 10, 1),
				50,
			),
			summarize:
				parameters.summarize === true ||
				String(parameters.summarize).toLowerCase() === "true",
			focusUser: parameters.focusUser ? String(parameters.focusUser) : null,
		};
	}
	for (let i = 0; i < 3; i++) {
		if (channelInfo) break;
		const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
		const parsed = parseJsonObjectFromText(response);
		if (parsed?.channelIdentifier) {
			channelInfo = {
				channelIdentifier: String(parsed.channelIdentifier),
				messageCount: Math.min(
					Math.max(Number(parsed.messageCount) || 10, 1),
					50,
				),
				summarize:
					parsed.summarize === true ||
					String(parsed.summarize).toLowerCase() === "true",
				focusUser: parsed.focusUser ? String(parsed.focusUser) : null,
			};
			break;
		}
	}
	if (!channelInfo) {
		await callback?.({
			text: "I couldn't understand which channel you want me to read from. Please specify the channel name or say 'this channel' for the current channel.",
			source: "discord",
		});
		return { success: false, error: "Could not parse channel information" };
	}

	const room = state.data?.room || (await runtime.getRoom(message.roomId));
	const targetChannel = await resolveTargetTextChannel(
		discordService,
		channelInfo.channelIdentifier,
		room?.channelId,
		room?.messageServerId,
	);
	if (!targetChannel?.isTextBased()) {
		await callback?.({
			text: "I couldn't find that channel or I don't have access to it. Make sure the channel exists and I have permission to read messages there.",
			source: "discord",
		});
		return { success: false, error: "Channel not found or not accessible" };
	}

	const clientUser = discordService.client.user;
	const botMember = clientUser
		? targetChannel.guild?.members.cache.get(clientUser.id)
		: undefined;
	if (botMember) {
		const permissions = targetChannel.permissionsFor(botMember);
		if (!permissions?.has(PermissionsBitField.Flags.ReadMessageHistory)) {
			await callback?.({
				text: "I don't have permission to read message history in that channel.",
				source: "discord",
			});
			return {
				success: false,
				error: "Missing ReadMessageHistory permission",
			};
		}
	}

	const requestedLimit = channelInfo.summarize
		? Math.max(channelInfo.messageCount * 2, 50)
		: channelInfo.messageCount;
	const fetchLimit = Math.min(requestedLimit, 100);
	const messages = await targetChannel.messages.fetch({ limit: fetchLimit });

	if (messages.size === 0) {
		await callback?.({
			text: `No messages found in <#${targetChannel.id}>.`,
			source: "discord",
		});
		return {
			success: true,
			text: "No messages found in channel",
			data: terminalActionResultData({ op: "read" }),
		};
	}

	if (channelInfo.summarize) {
		const sortedMessages = Array.from(messages.values()).reverse();
		const focusUserLower = channelInfo.focusUser?.toLowerCase();
		const relevantMessages = focusUserLower
			? sortedMessages.filter((msg) => {
					const memberDisplay = msg.member?.displayName?.toLowerCase();
					return (
						msg.author.username.toLowerCase().includes(focusUserLower) ||
						memberDisplay?.includes(focusUserLower)
					);
				})
			: sortedMessages;
		if (focusUserLower && relevantMessages.length === 0) {
			await callback?.({
				text: `I couldn't find any messages from "${channelInfo.focusUser}" in the recent messages from <#${targetChannel.id}>.`,
				source: "discord",
			});
			return {
				success: true,
				text: `No messages found from ${channelInfo.focusUser}`,
				data: terminalActionResultData({ op: "read" }),
			};
		}

		const messagesToSummarize = relevantMessages
			.slice(0, channelInfo.messageCount)
			.map((msg) => ({
				author: msg.author.username,
				content: msg.content || "[No text content]",
				timestamp: new Date(msg.createdTimestamp).toLocaleString(),
			}));

		const summaryPrompt = channelInfo.focusUser
			? `Please summarize what ${channelInfo.focusUser} has been discussing based on these messages from the Discord channel "${targetChannel.name}":\n\n${messagesToSummarize
					.map((m) => `${m.author} (${m.timestamp}): ${m.content}`)
					.join(
						"\n\n",
					)}\n\nProvide a concise summary focusing on:\n1. Main topics ${channelInfo.focusUser} discussed\n2. Key points or proposals they made\n3. Any questions they asked or issues they raised\n\nIf ${channelInfo.focusUser} didn't appear in these messages, please note that.`
			: `Please summarize the recent conversation in the Discord channel "${targetChannel.name}" based on these messages:\n\n${messagesToSummarize
					.map((m) => `${m.author} (${m.timestamp}): ${m.content}`)
					.join(
						"\n\n",
					)}\n\nProvide a concise summary that includes:\n1. Main topics discussed\n2. Key decisions or conclusions\n3. Who contributed what (mention specific usernames)\n4. Any action items or next steps mentioned`;
		const summary = await runtime.useModel(ModelType.TEXT_LARGE, {
			prompt: summaryPrompt,
		});
		const response: Content = {
			text: channelInfo.focusUser
				? `Summary of what ${channelInfo.focusUser} has been discussing in <#${targetChannel.id}>:\n\n${summary}`
				: `Summary of recent conversation in <#${targetChannel.id}>:\n\n${summary}`,
			actions: ["DISCORD_CHANNEL_OP_RESPONSE"],
			source: message.content.source,
		};
		await callback?.(response);
		return {
			success: true,
			text: response.text,
			data: terminalActionResultData({ op: "read" }),
		};
	}

	const formattedMessages = Array.from(messages.values())
		.reverse()
		.map((msg) => {
			const timestamp = new Date(msg.createdTimestamp).toLocaleString();
			const author = msg.author.username;
			const content = msg.content || "[No text content]";
			const attachments =
				msg.attachments.size > 0
					? `\nAttachments: ${msg.attachments
							.map((a) => a.name || "unnamed")
							.join(", ")}`
					: "";
			return `**${author}** (${timestamp}):\n${content}${attachments}`;
		})
		.join("\n\n---\n\n");

	const response: Content = {
		text: `Here are the last ${messages.size} messages from <#${targetChannel.id}>:\n\n${formattedMessages}`,
		actions: ["DISCORD_CHANNEL_OP_RESPONSE"],
		source: message.content.source,
	};
	await callback?.(response);
	return {
		success: true,
		text: response.text,
		data: terminalActionResultData({ op: "read" }),
	};
}

function searchInMessages(
	messages: Collection<string, Message>,
	query: string,
	author: string | null,
): Message[] {
	const queryLower = query.toLowerCase().trim();
	const isLinkSearch =
		queryLower.includes("link") || queryLower.includes("url");
	return Array.from(messages.values()).filter((msg) => {
		if (msg.system) return false;
		if (author && author !== "null" && author !== "undefined") {
			const authorLower = author.toLowerCase();
			const matchesUsername = msg.author.username
				.toLowerCase()
				.includes(authorLower);
			const matchesDisplayName =
				msg.member?.displayName?.toLowerCase().includes(authorLower) || false;
			if (!matchesUsername && !matchesDisplayName) return false;
		}
		if (isLinkSearch) {
			const urlRegex = /(https?:\/\/[^\s]+)/g;
			return urlRegex.test(msg.content);
		}
		const contentMatch = msg.content.toLowerCase().includes(queryLower);
		const embedMatch = msg.embeds.some(
			(embed) =>
				embed.title?.toLowerCase().includes(queryLower) ||
				embed.description?.toLowerCase().includes(queryLower) ||
				embed.author?.name?.toLowerCase().includes(queryLower) ||
				embed.fields?.some(
					(field) =>
						field.name?.toLowerCase().includes(queryLower) ||
						field.value?.toLowerCase().includes(queryLower),
				),
		);
		const attachmentMatch = msg.attachments.some(
			(att) =>
				att.name?.toLowerCase().includes(queryLower) ||
				att.description?.toLowerCase().includes(queryLower),
		);
		return contentMatch || embedMatch || attachmentMatch;
	});
}

async function handleSearch(
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
		template: searchMessagesTemplate,
	});
	let searchParams: {
		query: string;
		channelIdentifier: string;
		author: string | null;
		timeRange: string | null;
		limit: number;
	} | null = null;
	const parameters = getActionParameters(options);
	if (parameters.query) {
		const cleanQuery = String(parameters.query).replace(/^["']|["']$/g, "");
		searchParams = {
			query: cleanQuery,
			channelIdentifier: String(parameters.channelIdentifier || "current"),
			author: parameters.author ? String(parameters.author) : null,
			timeRange: parameters.timeRange ? String(parameters.timeRange) : null,
			limit: Math.min(Math.max(Number(parameters.limit) || 20, 1), 100),
		};
	}
	for (let i = 0; i < 3; i++) {
		if (searchParams) break;
		const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
		const parsed = parseJsonObjectFromText(response);
		if (parsed?.query) {
			const cleanQuery = String(parsed.query).replace(/^["']|["']$/g, "");
			searchParams = {
				query: cleanQuery,
				channelIdentifier: String(parsed.channelIdentifier || "current"),
				author: parsed.author ? String(parsed.author) : null,
				timeRange: parsed.timeRange ? String(parsed.timeRange) : null,
				limit: Math.min(Math.max(Number(parsed.limit) || 20, 1), 100),
			};
			break;
		}
	}
	if (!searchParams) {
		await callback?.({
			text: "I couldn't understand what you want to search for. Please specify what to search.",
			source: "discord",
		});
		return { success: false, error: "Could not parse search parameters" };
	}

	const room = state.data?.room || (await runtime.getRoom(message.roomId));
	const targetChannel = await resolveTargetTextChannel(
		discordService,
		searchParams.channelIdentifier,
		room?.channelId,
		room?.messageServerId,
	);
	if (!targetChannel?.isTextBased()) {
		await callback?.({
			text: "I couldn't find that channel or I don't have access to it.",
			source: "discord",
		});
		return { success: false, error: "Channel not found or not accessible" };
	}

	let before: number | undefined;
	if (searchParams.timeRange) {
		const now = Date.now();
		const timeMap: Record<string, number> = {
			hour: 60 * 60 * 1000,
			day: 24 * 60 * 60 * 1000,
			week: 7 * 24 * 60 * 60 * 1000,
			month: 30 * 24 * 60 * 60 * 1000,
		};
		if (timeMap[searchParams.timeRange]) {
			before = now - timeMap[searchParams.timeRange];
		}
	}
	const fetchedMessages = await targetChannel.messages.fetch({
		limit: 100,
		before: before?.toString(),
	});
	const results = searchInMessages(
		fetchedMessages,
		searchParams.query,
		searchParams.author,
	);
	const sortedResults = results.sort(
		(a, b) => b.createdTimestamp - a.createdTimestamp,
	);
	const limitedResults = sortedResults.slice(0, searchParams.limit);

	if (limitedResults.length === 0) {
		await callback?.({
			text: `No messages found matching "${searchParams.query}" in <#${targetChannel.id}>.`,
			source: "discord",
		});
		return {
			success: true,
			text: "No matching messages",
			data: terminalActionResultData({ op: "search" }),
		};
	}

	const formattedResults = limitedResults
		.map((msg, index) => {
			const timestamp = new Date(msg.createdTimestamp).toLocaleString();
			const preview =
				msg.content.length > 100
					? `${msg.content.substring(0, 100)}...`
					: msg.content;
			const attachments =
				msg.attachments.size > 0
					? `\nAttachments: ${msg.attachments.size}`
					: "";
			return `**${index + 1}.** ${msg.author.username} (${timestamp})\n${preview}${attachments}\n[Jump to message](${msg.url})`;
		})
		.join("\n\n");
	const response: Content = {
		text: `Found ${limitedResults.length} message${limitedResults.length !== 1 ? "s" : ""} matching "${searchParams.query}" in <#${targetChannel.id}>:\n\n${formattedResults}`,
		actions: ["DISCORD_CHANNEL_OP_RESPONSE"],
		source: message.content.source,
	};
	await callback?.(response);
	return {
		success: true,
		text: response.text,
		data: terminalActionResultData({ op: "search" }),
	};
}

const spec = requireActionSpec("DISCORD_CHANNEL_OP");

export const channelOp: Action = {
	name: spec.name,
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,
	descriptionCompressed: spec.descriptionCompressed,
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
				text: "I couldn't determine which Discord channel operation to run.",
				source: "discord",
			});
			return { success: false, error: "Could not resolve channel op" };
		}
		switch (op) {
			case "join":
				return handleJoin(runtime, message, currentState, options, callback);
			case "leave":
				return handleLeave(runtime, message, currentState, options, callback);
			case "read":
				return handleRead(runtime, message, currentState, options, callback);
			case "search":
				return handleSearch(runtime, message, currentState, options, callback);
		}
	},
	examples: (spec.examples ?? []) as ActionExample[][],
};

export default channelOp;
