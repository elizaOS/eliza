import type {
    Character,
    IAgentRuntime
} from "@elizaos/core";
import type {
    Client
} from "discord.js";

export interface IDiscordClient {
    apiToken: string;
    client: Client;
    runtime: IAgentRuntime;
    character: Character;
    stop(): Promise<void>;
}