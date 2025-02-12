import { getVoiceConnection } from "@discordjs/voice";
import { ChannelType, type Message as DiscordMessage } from "discord.js";
import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";

const voiceStateProvider: Provider = {
    get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        // Voice doesn't get a discord message, so we need to use the channel for guild data
        const discordMessage = (state?.discordMessage ||
            state.discordChannel) as DiscordMessage;
        const connection = getVoiceConnection(
            (discordMessage as DiscordMessage)?.guild?.id as string
        );
        const agentName = state?.agentName || "The agent";
        if (!connection) {
            return agentName + " is not currently in a voice channel";
        }

        const channel = (
            (state?.discordMessage as DiscordMessage) ||
            (state.discordChannel as DiscordMessage)
        )?.guild?.channels?.cache?.get(
            connection.joinConfig.channelId as string
        );

        if (!channel || channel.type !== ChannelType.GuildVoice) {
            return agentName + " is in an invalid voice channel";
        }

        return `${agentName} is currently in the voice channel: ${channel.name} (ID: ${channel.id})`;
    },
};

export default voiceStateProvider;
