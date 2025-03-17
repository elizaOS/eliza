import { type IAgentRuntime, type Plugin, logger } from '@elizaos/core';
import chatWithAttachments from './actions/chatWithAttachments';
import { downloadMedia } from './actions/downloadMedia';
import { summarize } from './actions/summarizeConversation';
import { transcribeMedia } from './actions/transcribeMedia';
import { joinVoice } from './actions/voiceJoin';
import { leaveVoice } from './actions/voiceLeave';
import { channelStateProvider } from './providers/channelState';
import { voiceStateProvider } from './providers/voiceState';
import { DiscordService } from './service';
import { DiscordTestSuite } from './tests';

const discordPlugin: Plugin = {
  name: 'discord',
  description: 'Discord service plugin for integration with Discord servers and channels',
  services: [DiscordService],
  actions: [chatWithAttachments, downloadMedia, joinVoice, leaveVoice, summarize, transcribeMedia],
  providers: [channelStateProvider, voiceStateProvider],
  tests: [new DiscordTestSuite()],
  init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
    const token = runtime.getSetting('DISCORD_API_TOKEN') as string;

    if (!token || token.trim() === '') {
      logger.warn(
        'Discord API Token not provided - Discord plugin is loaded but will not be functional'
      );
      logger.warn(
        'To enable Discord functionality, please provide DISCORD_API_TOKEN in your .eliza/.env file'
      );
    }
  },
};

export default discordPlugin;
