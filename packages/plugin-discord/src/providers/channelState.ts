import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { ChannelType } from "@elizaos/core";
import { ServiceTypes } from "../types.ts";
import type { DiscordService } from "../index.ts";

const channelStateProvider: Provider = {
    name: "channelState",
    get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        const room = state.data?.room ?? await runtime.getDatabaseAdapter().getRoom(message.roomId);
        if(!room) {
            throw new Error("No room found");
        }

        // if message source is not discord, return
        if(message.content.source !== "discord") {
            return {
                data: null,
                values: {},
                text: ""
            };
        }

        const agentName = state?.agentName || "The agent";
        const senderName = state?.senderName || "someone";

        let responseText = "";
        let channelType = "";
        let serverName = "";
        let channelId = "";
        const serverId = room.serverId;

        if (room.type === ChannelType.DM) {
            channelType = "DM";
            responseText = `${agentName} is currently in a direct message conversation with ${senderName}. ${agentName} should engage in conversation, should respond to messages that are addressed to them and only ignore messages that seem to not require a response.`;
        } else {
            channelType = "GROUP";
            
            if (!serverId) {
                console.error("No server ID found");
                return {
                    data: {
                        room,
                        channelType
                    },
                    values: {
                        channelType
                    },
                    text: ""
                };
            }

            channelId = room.channelId;

            const discordService = runtime.getService(ServiceTypes.DISCORD) as DiscordService;
            if(!discordService) {
                console.warn("No discord client found");
                return {
                    data: {
                        room,
                        channelType,
                        serverId
                    },
                    values: {
                        channelType,
                        serverId
                    },
                    text: ""
                };
            }

            const guild = discordService.client.guilds.cache.get(serverId);
            serverName = guild.name;

            responseText = `${agentName} is currently having a conversation in the channel \`@${channelId} in the server \`${serverName}\` (@${serverId})`;
            responseText += `\n${agentName} is in a room with other users and should be self-conscious and only participate when directly addressed or when the conversation is relevant to them.`;
        }

        return {
            data: {
                room,
                channelType,
                serverId,
                serverName,
                channelId
            },
            values: {
                channelType,
                serverName,
                channelId
            },
            text: responseText
        };
    },
};

export default channelStateProvider;
