// src/actions/leaveVoice
import {
  type Action,
  type ActionExample,
  ChannelType,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  createUniqueUuid,
  logger,
} from '@elizaos/core';
import { BaseGuildVoiceChannel } from 'discord.js';

import type { DiscordService } from '../service';
import { ServiceType } from '../types';
import type { VoiceManager } from '../voice';

export const leaveVoice: Action = {
  name: 'LEAVE_VOICE',
  similes: [
    'LEAVE_VOICE',
    'LEAVE_VC',
    'LEAVE_VOICE_CHAT',
    'LEAVE_VOICE_CHANNEL',
    'LEAVE_MEETING',
    'LEAVE_CALL',
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    if (message.content.source !== 'discord') {
      // not a discord message
      return false;
    }

    const service = runtime.getService(ServiceType.DISCORD) as DiscordService;

    if (!service) {
      logger.error('Discord client not found');
      return false;
    }

    const room = state.data.room ?? (await runtime.getRoom(message.roomId));

    if (room?.type !== ChannelType.GROUP && room?.type !== ChannelType.VOICE_GROUP) {
      return false;
    }

    // Check if the client is connected to any voice channel
    const isConnectedToVoice = service.client.voice.adapters.size > 0;

    return isConnectedToVoice;
  },
  description: 'Leave the current voice channel.',
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any
  ): Promise<boolean> => {
    const room = await runtime.getRoom(message.roomId);
    if (!room) {
      throw new Error('No room found');
    }

    if (room?.type !== ChannelType.GROUP && room?.type !== ChannelType.VOICE_GROUP) {
      throw new Error('Not a group');
    }

    const serverId = room.serverId;

    if (!serverId) {
      throw new Error('No server ID found 9');
    }
    const discordClient = runtime.getService(ServiceType.DISCORD) as DiscordService;
    const voiceManager = discordClient.voiceManager as VoiceManager;
    const client = discordClient.client;

    if (!client) {
      logger.error('Discord client not found');
      throw new Error('Discord client not found');
    }

    if (!voiceManager) {
      logger.error('voiceManager is not available.');
      throw new Error('voiceManager is not available.');
    }

    const guild = client.guilds.cache.get(serverId);

    if (!guild) {
      console.warn('Bot is not in any voice channel.');
      // create a memory with thought to self to self
      await runtime.createMemory(
        {
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: 'discord',
            thought: "I tried to leave the voice channel but I'm not in any voice channel.",
            actions: ['LEAVE_VOICE'],
          },
          metadata: {
            type: 'LEAVE_VOICE',
          },
        },
        'messages'
      );
      return false;
    }

    const voiceChannel = guild.members.me?.voice.channel;

    if (!voiceChannel || !(voiceChannel instanceof BaseGuildVoiceChannel)) {
      console.warn('Could not retrieve the voice channel.');
      await runtime.createMemory(
        {
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: 'discord',
            thought: "I tried to leave the voice channel but I couldn't find it.",
            actions: ['LEAVE_VOICE'],
          },
          metadata: {
            type: 'LEAVE_VOICE',
          },
        },
        'messages'
      );
      return false;
    }

    const connection = voiceManager.getVoiceConnection(guild.id);
    if (!connection) {
      console.warn('No active voice connection found for the bot.');
      await runtime.createMemory(
        {
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: 'discord',
            thought: "I tried to leave the voice channel but I couldn't find the connection.",
            actions: ['LEAVE_VOICE'],
          },
          metadata: {
            type: 'LEAVE_VOICE',
          },
        },
        'messages'
      );
      return false;
    }

    voiceManager.leaveChannel(voiceChannel);
    // save a memory for the new channel as well
    await runtime.createMemory(
      {
        entityId: message.entityId,
        agentId: message.agentId,
        roomId: createUniqueUuid(runtime, voiceChannel.id),
        content: {
          source: 'discord',
          thought: `I left the voice channel ${voiceChannel.name}`,
          actions: ['LEAVE_VOICE_STARTED'],
        },
        metadata: {
          type: 'LEAVE_VOICE',
        },
      },
      'messages'
    );

    return true;
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Hey {{name2}} please leave the voice channel',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Sure',
          actions: ['LEAVE_VOICE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'I have to go now but thanks for the chat',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'You too, talk to you later',
          actions: ['LEAVE_VOICE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Great call everyone, hopping off now',
          actions: ['LEAVE_VOICE'],
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "Agreed, I'll hop off too",
          actions: ['LEAVE_VOICE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Hey {{name2}} I need you to step away from the voice chat for a bit',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "No worries, I'll leave the voice channel",
          actions: ['LEAVE_VOICE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: '{{name2}}, I think we covered everything, you can leave the voice chat now',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Sounds good, see you both later',
          actions: ['LEAVE_VOICE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'leave voice {{name2}}',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'ok leaving',
          actions: ['LEAVE_VOICE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'plz leave the voice chat {{name2}}',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'aight im out',
          actions: ['LEAVE_VOICE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'yo {{name2}} gtfo the vc',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'sorry, talk to you later',
          actions: ['LEAVE_VOICE'],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

export default leaveVoice;
