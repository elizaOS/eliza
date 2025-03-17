import type { IAgentRuntime, Memory, Provider, State } from '@elizaos/core';
import { ChannelType } from '@elizaos/core';
import type { DiscordService } from '../service';
import { ServiceType } from '../types';

/**
 * Represents a provider for retrieving channel state information.
 * @type {Provider}
 * @property {string} name - The name of the channel state provider.
 * @property {Function} get - Asynchronous function that retrieves channel state information based on the provided runtime, message, and optional state parameters.
 * @param {IAgentRuntime} runtime - The agent runtime.
 * @param {Memory} message - The message object.
 * @param {State} [state] - Optional state object.
 * @returns {Promise<Object>} A promise that resolves to an object containing channel state data, values, and text.
 */
export const channelStateProvider: Provider = {
  name: 'channelState',
  get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    const room = state.data?.room ?? (await runtime.getRoom(message.roomId));
    if (!room) {
      throw new Error('No room found');
    }

    // if message source is not discord, return
    if (message.content.source !== 'discord') {
      return {
        data: null,
        values: {},
        text: '',
      };
    }

    const agentName = state?.agentName || 'The agent';
    const senderName = state?.senderName || 'someone';

    let responseText = '';
    let channelType = '';
    let serverName = '';
    let channelId = '';
    const serverId = room.serverId;

    if (room.type === ChannelType.DM) {
      channelType = 'DM';
      responseText = `${agentName} is currently in a direct message conversation with ${senderName}. ${agentName} should engage in conversation, should respond to messages that are addressed to them and only ignore messages that seem to not require a response.`;
    } else {
      channelType = 'GROUP';

      if (!serverId) {
        console.error('No server ID found');
        return {
          data: {
            room,
            channelType,
          },
          values: {
            channelType,
          },
          text: '',
        };
      }

      channelId = room.channelId;

      const discordService = runtime.getService(ServiceType.DISCORD) as DiscordService;
      if (!discordService) {
        console.warn('No discord client found');
        return {
          data: {
            room,
            channelType,
            serverId,
          },
          values: {
            channelType,
            serverId,
          },
          text: '',
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
        channelId,
      },
      values: {
        channelType,
        serverName,
        channelId,
      },
      text: responseText,
    };
  },
};

export default channelStateProvider;
