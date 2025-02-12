import {
    ChannelType,
    type Message as DiscordMessage,
    type TextChannel,
} from "discord.js";
import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";

const channelStateProvider: Provider = {
    get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        const discordMessage =
            (state?.discordMessage as DiscordMessage) ||
            (state?.discordChannel as DiscordMessage);
        if (!discordMessage) {
            return "";
        }

        const guild = discordMessage?.guild;
        const agentName = state?.agentName || "The agent";
        const senderName = state?.senderName || "someone";

        if (!guild) {
            return (
                agentName +
                " is currently in a direct message conversation with " +
                senderName
            );
        }

        const serverName = guild.name; // The name of the server
        const guildId = guild.id; // The ID of the guild
        const channel = discordMessage.channel;

        if (!channel) {
            console.log("channel is null");
            return "";
        }

        let response =
            agentName +
            " is currently having a conversation in the channel `@" +
            channel.id +
            " in the server `" +
            serverName +
            "` (@" +
            guildId +
            ")";
        if (
            channel.type === ChannelType.GuildText &&
            (channel as TextChannel).topic
        ) {
            // Check if the channel is a text channel
            response +=
                "\nThe topic of the channel is: " +
                (channel as TextChannel).topic;
        }
        return response;
    },
};

export default channelStateProvider;
