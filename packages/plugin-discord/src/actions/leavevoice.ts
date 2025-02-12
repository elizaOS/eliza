// src/actions/leaveVoice
import { getVoiceConnection } from "@discordjs/voice";
import {
    type Channel,
    ChannelType,
    type Client,
    type Message as DiscordMessage,
} from "discord.js";
import type {
    Action,
    ActionExample,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
} from "@elizaos/core";

export default {
    name: "LEAVE_VOICE",
    similes: [
        "LEAVE_VOICE",
        "LEAVE_VC",
        "LEAVE_VOICE_CHAT",
        "LEAVE_VOICE_CHANNEL",
        "LEAVE_MEETING",
        "LEAVE_CALL",
    ],
    validate: async (runtime: IAgentRuntime, message: Memory, state: State) => {
        if (message.content.source !== "discord") {
            // not a discord message
            return false;
        }

        if (!state.discordClient) {
            return false;
        }

        const keywords = [
            "leave",
            "exit",
            "stop",
            "quit",
            "get off",
            "get out",
            "bye",
            "cya",
            "see you",
            "hop off",
            "get off",
            "voice",
            "vc",
            "chat",
            "call",
            "meeting",
            "discussion",
        ];
        if (
            !keywords.some((keyword) =>
                message.content.text.toLowerCase().includes(keyword)
            )
        ) {
            return false;
        }

        const client = state.discordClient as Client;

        // Check if the client is connected to any voice channel
        const isConnectedToVoice = client.voice.adapters.size > 0;

        return isConnectedToVoice;
    },
    description: "Leave the current voice channel.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback,
        responses: Memory[]
    ): Promise<boolean> => {
        if (!state.discordClient) {
            return;
        }

        for (const response of responses) {
            await callback(response.content);
        }

        const discordMessage = (state.discordMessage ||
            state.discordChannel) as DiscordMessage;

        if (!discordMessage) {
            throw new Error("Discord message is not available in the state.");
        }
        const voiceChannels = (state.discordClient as Client)?.guilds.cache
            .get((discordMessage as DiscordMessage).guild?.id as string)
            ?.channels.cache.filter(
                (channel: Channel) => channel.type === ChannelType.GuildVoice
            );

        voiceChannels?.forEach((_channel: Channel) => {
            const connection = getVoiceConnection(
                (discordMessage as DiscordMessage).guild?.id as string
            );
            if (connection) {
                connection.destroy();
            }
        });
        return true;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Hey {{user2}} please leave the voice channel",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Sure",
                    action: "LEAVE_VOICE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "I have to go now but thanks for the chat",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "You too, talk to you later",
                    action: "LEAVE_VOICE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Great call everyone, hopping off now",
                    action: "LEAVE_VOICE",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Agreed, I'll hop off too",
                    action: "LEAVE_VOICE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Hey {{user2}} I need you to step away from the voice chat for a bit",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "No worries, I'll leave the voice channel",
                    action: "LEAVE_VOICE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "{{user2}}, I think we covered everything, you can leave the voice chat now",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Sounds good, see you both later",
                    action: "LEAVE_VOICE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "leave voice {{user2}}",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "ok leaving",
                    action: "LEAVE_VOICE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "plz leave the voice chat {{user2}}",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "aight im out",
                    action: "LEAVE_VOICE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "yo {{user2}} gtfo the vc",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "sorry, talk to you later",
                    action: "LEAVE_VOICE",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
