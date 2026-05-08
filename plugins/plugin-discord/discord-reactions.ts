/**
 * Discord reaction handling — extracted from service.ts
 *
 * Contains handleReaction(), handleReactionAdd(), handleReactionRemove().
 */
import {
	type ChannelType,
	createUniqueUuid,
	type EventPayload,
	EventType,
	type HandlerCallback,
	type Memory,
	stringToUuid,
	type UUID,
} from "@elizaos/core";
import type {
	Channel,
	MessageReaction,
	PartialMessageReaction,
	PartialUser,
	TextChannel,
	User,
} from "discord.js";
import { buildDiscordWorldMetadata } from "./identity";
import type { DiscordService } from "./service";
import { DiscordEventTypes, type DiscordReactionPayload } from "./types";
import { normalizeDiscordMessageText } from "./utils";

/**
 * Subset of DiscordService fields needed by reaction handlers.
 */
export interface ReactionServiceInternals {
	accountId?: string;
	runtime: DiscordService["runtime"];
	resolveDiscordEntityId(userId: string): UUID;
	getChannelType(channel: Channel): Promise<ChannelType>;
}

/**
 * Generic handler for reaction events (add/remove).
 */
export async function handleReaction(
	service: ReactionServiceInternals,
	reaction: MessageReaction | PartialMessageReaction,
	user: User | PartialUser,
	type: "add" | "remove",
): Promise<void> {
	try {
		const accountId = service.accountId ?? "default";
		const actionVerb = type === "add" ? "added" : "removed";
		const actionText = type === "add" ? "Added" : "Removed";
		const preposition = type === "add" ? "to" : "from";

		service.runtime.logger.debug(
			{ src: "plugin:discord", agentId: service.runtime.agentId, type },
			`Reaction ${actionVerb}`,
		);

		// Early returns
		if (!reaction || !user) {
			service.runtime.logger.warn("Invalid reaction or user");
			return;
		}

		// Get emoji info
		let emoji = reaction.emoji.name;
		if (!emoji && reaction.emoji.id) {
			emoji = `<:${reaction.emoji.name}:${reaction.emoji.id}>`;
		}

		// Fetch full message if partial
		if (reaction.partial) {
			try {
				await reaction.fetch();
			} catch (error) {
				service.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						error: error instanceof Error ? error.message : String(error),
					},
					"Failed to fetch partial reaction",
				);
				return;
			}
		}

		// Generate IDs with timestamp to ensure uniqueness
		const timestamp = Date.now();
		const roomId = createUniqueUuid(
			service.runtime,
			reaction.message.channel.id,
		);
		const entityId = service.resolveDiscordEntityId(user.id);
		const reactionUUID = createUniqueUuid(
			service.runtime,
			`${reaction.message.id}-${user.id}-${emoji}-${timestamp}`,
		);

		// Validate IDs
		if (!entityId || !roomId) {
			service.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					entityId,
					roomId,
				},
				"Invalid user ID or room ID",
			);
			return;
		}

		// Process message content
		const messageContent = reaction.message.content || "";
		const truncatedContent =
			messageContent.length > 50
				? `${messageContent.substring(0, 50)}...`
				: messageContent;
		const reactionMessage = `*${actionText} <${emoji}> ${preposition}: \\"${truncatedContent}\\"*`;

		// Get user info from the reacting user (not the message author)
		const reactionMessageAuthor = reaction.message.author;
		const userName =
			("username" in user && (user as User).username) ||
			reactionMessageAuthor?.username ||
			"unknown";
		const name =
			("globalName" in user && typeof user.globalName === "string"
				? user.globalName
				: undefined) ||
			(reactionMessageAuthor &&
			"displayName" in reactionMessageAuthor &&
			typeof reactionMessageAuthor.displayName === "string"
				? reactionMessageAuthor.displayName
				: undefined) ||
			userName;

		// Get channel type once and reuse
		const channelType = await service.getChannelType(
			reaction.message.channel as Channel,
		);

		await service.runtime.ensureConnection({
			entityId,
			roomId,
			roomName:
				"name" in reaction.message.channel &&
				typeof reaction.message.channel.name === "string"
					? reaction.message.channel.name
					: name,
			userName,
			worldId: createUniqueUuid(
				service.runtime,
				reaction.message.guild?.id ?? roomId,
			) as UUID,
			worldName: reaction.message.guild?.name || undefined,
			name,
			source: "discord",
			channelId: reaction.message.channel.id,
			messageServerId: reaction.message.guild?.id
				? stringToUuid(reaction.message.guild.id)
				: undefined,
			type: channelType,
			userId: user.id as unknown as UUID,
			metadata: {
				...buildDiscordWorldMetadata(
					service.runtime,
					reaction.message.guild?.ownerId,
				),
				accountId,
			},
		});

		const inReplyTo = createUniqueUuid(service.runtime, reaction.message.id);

		const memory: Memory = {
			id: reactionUUID,
			entityId,
			agentId: service.runtime.agentId,
			content: {
				text: reactionMessage,
				source: "discord",
				inReplyTo,
				channelType,
			},
			metadata: {
				accountId,
				entityName: name,
				entityUserName: userName,
				fromId: user.id,
				discordReaction: {
					action: type,
					emoji,
					targetMessageId: inReplyTo,
				},
			},
			roomId,
			createdAt: timestamp,
		};

		const callback: HandlerCallback = async (content): Promise<Memory[]> => {
			if (!reaction.message.channel) {
				service.runtime.logger.error(
					{ src: "plugin:discord", agentId: service.runtime.agentId },
					"No channel found for reaction message",
				);
				return [];
			}
			const responseText = normalizeDiscordMessageText(content.text);
			if (!responseText.trim()) {
				return [];
			}
			await (reaction.message.channel as TextChannel).send(responseText);
			return [];
		};

		const events =
			type === "add"
				? [DiscordEventTypes.REACTION_RECEIVED, EventType.REACTION_RECEIVED]
				: [DiscordEventTypes.REACTION_REMOVED];

		const reactionPayload: DiscordReactionPayload & EventPayload = {
			runtime: service.runtime,
			message: memory,
			originalReaction: reaction as MessageReaction,
			user: user as User,
			source: "discord",
			accountId,
			callback,
		};
		service.runtime.emitEvent(events, reactionPayload);
	} catch (error) {
		service.runtime.logger.error(
			{
				src: "plugin:discord",
				agentId: service.runtime.agentId,
				error: error instanceof Error ? error.message : String(error),
			},
			"Error handling reaction",
		);
	}
}

/**
 * Handles reaction addition.
 */
export async function handleReactionAdd(
	service: ReactionServiceInternals,
	reaction: MessageReaction | PartialMessageReaction,
	user: User | PartialUser,
): Promise<void> {
	await handleReaction(service, reaction, user, "add");
}

/**
 * Handles reaction removal.
 */
export async function handleReactionRemove(
	service: ReactionServiceInternals,
	reaction: MessageReaction | PartialMessageReaction,
	user: User | PartialUser,
): Promise<void> {
	await handleReaction(service, reaction, user, "remove");
}
