/**
 * Discord slash command registration — extracted from service.ts
 *
 * Contains transformCommandToDiscordApi(), isGuildOnlyCommand(),
 * handleGuildCreate(), and the core registerSlashCommands() logic.
 */
import {
	createUniqueUuid,
	type EventPayload,
	EventType,
	type World,
} from "@elizaos/core";
import type {
	ApplicationCommandDataResolvable,
	ChatInputApplicationCommandData,
	Guild,
} from "discord.js";
import type { InteractionServiceInternals } from "./discord-interactions";
import {
	buildStandardizedRooms,
	buildStandardizedUsers,
} from "./discord-interactions";
import { buildDiscordWorldMetadata } from "./identity";
import type { DiscordSlashCommand } from "./types";
import { DiscordEventTypes } from "./types";

/**
 * Transforms an ElizaOS slash command to Discord API format.
 */
export function transformCommandToDiscordApi(
	cmd: DiscordSlashCommand,
): ApplicationCommandDataResolvable {
	const discordCmd: ChatInputApplicationCommandData & {
		contexts?: number[];
		default_member_permissions?: string;
	} = {
		name: cmd.name,
		description: cmd.description,
		options: cmd.options,
	};

	if (cmd.contexts) {
		discordCmd.contexts = cmd.contexts;
	} else if (cmd.guildOnly) {
		discordCmd.contexts = [0]; // 0 = Guild only (no DMs)
	}

	if (cmd.requiredPermissions !== undefined) {
		discordCmd.default_member_permissions =
			typeof cmd.requiredPermissions === "bigint"
				? cmd.requiredPermissions.toString()
				: cmd.requiredPermissions;
	}

	return discordCmd;
}

/**
 * Checks if a command is guild-only.
 */
export function isGuildOnlyCommand(cmd: DiscordSlashCommand): boolean {
	if (cmd.contexts) {
		return cmd.contexts.length === 1 && cmd.contexts[0] === 0;
	}
	return !!cmd.guildOnly;
}

/**
 * Handles the event when the bot joins a guild.
 */
export async function handleGuildCreate(
	service: InteractionServiceInternals,
	guild: Guild,
): Promise<void> {
	service.runtime.logger.info(`Joined guild: ${guild.name} (${guild.id})`);
	const fullGuild = await guild.fetch();

	// Register commands to the newly joined guild
	const clientApplication = service.client?.application;
	if (service.slashCommands.length > 0 && clientApplication) {
		try {
			const generalCommands = service.slashCommands.filter(
				(cmd) => cmd.guildIds.length === 0,
			);

			const targetedCommandsForThisGuild = service.slashCommands.filter((cmd) =>
				cmd.guildIds?.includes(fullGuild.id),
			);

			const commandMap = new Map<string, DiscordSlashCommand>();
			for (const cmd of [...generalCommands, ...targetedCommandsForThisGuild]) {
				if (cmd.name) {
					commandMap.set(cmd.name, cmd);
				}
			}
			const commandsToRegister = Array.from(commandMap.values());

			if (commandsToRegister.length > 0) {
				const discordCommands = commandsToRegister.map((cmd) =>
					transformCommandToDiscordApi(cmd),
				);

				await service.client.application.commands.set(
					discordCommands,
					fullGuild.id,
				);
				service.runtime.logger.info(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						guildId: fullGuild.id,
						guildName: fullGuild.name,
						generalCount: generalCommands.length,
						targetedCount: targetedCommandsForThisGuild.length,
						totalCount: discordCommands.length,
					},
					"Commands registered to newly joined guild",
				);
			}
		} catch (error) {
			service.runtime.logger.warn(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					guildId: fullGuild.id,
					guildName: fullGuild.name,
					error: error instanceof Error ? error.message : String(error),
				},
				"Failed to register commands to newly joined guild",
			);
		}
	}

	// Create standardized world data structure
	const worldId = createUniqueUuid(service.runtime, fullGuild.id);
	const standardizedData = {
		runtime: service.runtime,
		rooms: await buildStandardizedRooms(service, fullGuild, worldId),
		entities: await buildStandardizedUsers(service, fullGuild),
		world: {
			id: worldId,
			name: fullGuild.name,
			agentId: service.runtime.agentId,
			serverId: fullGuild.id,
			metadata: {
				...buildDiscordWorldMetadata(service.runtime, fullGuild.ownerId),
			},
		} as World,
		source: "discord",
	};

	service.runtime.emitEvent([DiscordEventTypes.WORLD_JOINED], {
		runtime: service.runtime,
		source: "discord",
		world: standardizedData.world,
		rooms: standardizedData.rooms,
		entities: standardizedData.entities,
		server: fullGuild,
	} as EventPayload);

	service.runtime.emitEvent([EventType.WORLD_JOINED], standardizedData);
}
