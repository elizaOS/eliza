import type { Character, IAgentRuntime } from "@elizaos/core";
import type { Client } from "discord.js";

/**
 * Interface representing a Discord service.
 * 
 * @typedef {Object} IDiscordService
 * @property {Client} client - The Discord client object.
 * @property {Character} character - The character object.
 */
export interface IDiscordService {
	client: Client;
	character: Character;
}

export const ServiceTypes = {
	DISCORD: "discord",
} as const;
