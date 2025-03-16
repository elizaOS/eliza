import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  type VoiceConnection,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
} from '@discordjs/voice';
import { type IAgentRuntime, ModelType, type TestSuite, logger } from '@elizaos/core';
import { ChannelType, Events, type TextChannel } from 'discord.js';
import type { DiscordService } from './service';
import { ServiceType } from './types';
import { sendMessageInChunks } from './utils';

const TEST_IMAGE_URL =
  'https://github.com/elizaOS/awesome-eliza/blob/main/assets/eliza-logo.jpg?raw=true';

/**
 * Represents a test suite for Discord functionality.
 * @class DiscordTestSuite
 * @implements TestSuite
 * @property {string} name - The name of the test suite
 * @property {DiscordService | null} discordClient - The Discord client instance
 * @property {Array<{ name: string; fn: (runtime: IAgentRuntime) => Promise<void> }>} tests - Array of test functions
 */
export class DiscordTestSuite implements TestSuite {
  name = 'discord';
  private discordClient: DiscordService | null = null;
  tests: { name: string; fn: (runtime: IAgentRuntime) => Promise<void> }[];

  /**
   * Constructor for initializing the tests array with test cases to be executed.
   *
   * @constructor
   * @this {TestSuite}
   */
  constructor() {
    this.tests = [
      {
        name: 'Initialize Discord Client',
        fn: this.testCreatingDiscordClient.bind(this),
      },
      {
        name: 'Slash Commands - Join Voice',
        fn: this.testJoinVoiceSlashCommand.bind(this),
      },
      {
        name: 'Voice Playback & TTS',
        fn: this.testTextToSpeechPlayback.bind(this),
      },
      {
        name: 'Send Message with Attachments',
        fn: this.testSendingTextMessage.bind(this),
      },
      {
        name: 'Handle Incoming Messages',
        fn: this.testHandlingMessage.bind(this),
      },
      {
        name: 'Slash Commands - Leave Voice',
        fn: this.testLeaveVoiceSlashCommand.bind(this),
      },
    ];
  }

  /**
   * Asynchronously tests the creation of Discord client using the provided runtime.
   *
   * @param {IAgentRuntime} runtime - The agent runtime used to obtain the Discord service.
   * @returns {Promise<void>} - A Promise that resolves once the Discord client is ready.
   * @throws {Error} - If an error occurs while creating the Discord client.
   */
  async testCreatingDiscordClient(runtime: IAgentRuntime) {
    try {
      this.discordClient = runtime.getService(ServiceType.DISCORD) as DiscordService;

      // Wait for the bot to be ready before proceeding
      if (this.discordClient.client.isReady()) {
        logger.success('DiscordService is already ready.');
      } else {
        logger.info('Waiting for DiscordService to be ready...');
        await new Promise((resolve, reject) => {
          this.discordClient.client.once(Events.ClientReady, resolve);
          this.discordClient.client.once(Events.Error, reject);
        });
      }
    } catch (error) {
      throw new Error(`Error in test creating Discord client: ${error}`);
    }
  }

  /**
   * Asynchronously tests the join voice slash command functionality.
   *
   * @param {IAgentRuntime} runtime - The runtime environment for the agent.
   * @returns {Promise<void>} - A promise that resolves once the test is complete.
   * @throws {Error} - If there is an error in executing the slash command test.
   */
  async testJoinVoiceSlashCommand(runtime: IAgentRuntime) {
    try {
      await this.waitForVoiceManagerReady(this.discordClient);

      const channel = await this.getTestChannel(runtime);
      if (!channel || !channel.isTextBased()) {
        throw new Error('Invalid test channel for slash command test.');
      }

      // Simulate a join channel slash command interaction
      const fakeJoinInteraction = {
        isCommand: () => true,
        commandName: 'joinchannel',
        options: {
          get: (name: string) => (name === 'channel' ? { value: channel.id } : null),
        },
        guild: (channel as TextChannel).guild,
        deferReply: async () => {},
        editReply: async (message: string) => {
          logger.info(`JoinChannel Slash Command Response: ${message}`);
        },
      };

      await this.discordClient.voiceManager.handleJoinChannelCommand(fakeJoinInteraction as any);

      logger.success('Slash command test completed successfully.');
    } catch (error) {
      throw new Error(`Error in slash commands test: ${error}`);
    }
  }

  /**
   * Asynchronously tests the leave voice channel slash command.
   *
   * @param {IAgentRuntime} runtime - The Agent Runtime instance.
   * @returns {Promise<void>} A promise that resolves when the test is complete.
   */
  async testLeaveVoiceSlashCommand(runtime: IAgentRuntime) {
    try {
      await this.waitForVoiceManagerReady(this.discordClient);

      const channel = await this.getTestChannel(runtime);
      if (!channel || !channel.isTextBased()) {
        throw new Error('Invalid test channel for slash command test.');
      }

      // Simulate a leave channel slash command interaction
      const fakeLeaveInteraction = {
        isCommand: () => true,
        commandName: 'leavechannel',
        guildId: (channel as TextChannel).guildId,
        reply: async (message: string) => {
          logger.info(`LeaveChannel Slash Command Response: ${message}`);
        },
      };

      await this.discordClient.voiceManager.handleLeaveChannelCommand(fakeLeaveInteraction as any);

      logger.success('Slash command test completed successfully.');
    } catch (error) {
      throw new Error(`Error in slash commands test: ${error}`);
    }
  }

  /**
   * Test Text to Speech playback.
   * @param {IAgentRuntime} runtime - The Agent Runtime instance.
   * @throws {Error} - If voice channel is invalid, voice connection fails to become ready, or no text to speech service found.
   */
  async testTextToSpeechPlayback(runtime: IAgentRuntime) {
    try {
      await this.waitForVoiceManagerReady(this.discordClient);

      const channel = await this.getTestChannel(runtime);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        throw new Error('Invalid voice channel.');
      }

      await this.discordClient.voiceManager.joinChannel(channel);

      const guild = await this.getActiveGuild(this.discordClient);
      const guildId = guild.id;
      const connection = this.discordClient.voiceManager.getVoiceConnection(guildId);

      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
        logger.success(`Voice connection is ready in guild: ${guildId}`);
      } catch (error) {
        throw new Error(`Voice connection failed to become ready: ${error}`);
      }

      let responseStream = null;

      try {
        responseStream = await runtime.useModel(
          ModelType.TEXT_TO_SPEECH,
          `Hi! I'm ${runtime.character.name}! How are you doing today?`
        );
      } catch (_error) {
        throw new Error('No text to speech service found');
      }

      if (!responseStream) {
        throw new Error('TTS response stream is null or undefined.');
      }

      await this.playAudioStream(responseStream, connection);
    } catch (error) {
      throw new Error(`Error in TTS playback test: ${error}`);
    }
  }

  /**
   * Asynchronously tests sending a text message to a specified channel.
   *
   * @param {IAgentRuntime} runtime - The runtime for the agent.
   * @returns {Promise<void>} A Promise that resolves when the message is sent successfully.
   * @throws {Error} If there is an error in sending the text message.
   */
  async testSendingTextMessage(runtime: IAgentRuntime) {
    try {
      const channel = await this.getTestChannel(runtime);

      await this.sendMessageToChannel(channel as TextChannel, 'Testing Message', [TEST_IMAGE_URL]);
    } catch (error) {
      throw new Error(`Error in sending text message: ${error}`);
    }
  }

  /**
   * Asynchronously handles sending a test message using the given runtime and mock user data.
   *
   * @param {IAgentRuntime} runtime - The agent runtime object.
   * @returns {Promise<void>} A Promise that resolves once the message is handled.
   */
  async testHandlingMessage(runtime: IAgentRuntime) {
    try {
      const channel = await this.getTestChannel(runtime);

      const fakeMessage = {
        content: `Hello, ${runtime.character.name}! How are you?`,
        author: {
          id: 'mock-user-id',
          username: 'MockUser',
          bot: false,
        },
        channel,
        id: 'mock-message-id',
        createdTimestamp: Date.now(),
        mentions: {
          has: () => false,
        },
        reference: null,
        attachments: [],
      };
      await this.discordClient.messageManager.handleMessage(fakeMessage as any);
    } catch (error) {
      throw new Error(`Error in sending text message: ${error}`);
    }
  }

  // #############################
  //     Utility Functions
  // #############################

  /**
   * Asynchronously retrieves the test channel associated with the provided runtime.
   *
   * @param {IAgentRuntime} runtime - The runtime object containing necessary information.
   * @returns {Promise<Channel>} The test channel retrieved from the Discord client.
   * @throws {Error} If no test channel is found.
   */
  async getTestChannel(runtime: IAgentRuntime) {
    const channelId = this.validateChannelId(runtime);
    const channel = await this.discordClient.client.channels.fetch(channelId);

    if (!channel) throw new Error('no test channel found!');

    return channel;
  }

  /**
   * Async function to send a message to a text-based channel.
   *
   * @param {TextChannel} channel - The text-based channel the message is being sent to.
   * @param {string} messageContent - The content of the message being sent.
   * @param {any[]} files - An array of files to include in the message.
   * @throws {Error} If the channel is not a text-based channel or does not exist.
   * @throws {Error} If there is an error sending the message.
   */
  async sendMessageToChannel(channel: TextChannel, messageContent: string, files: any[]) {
    try {
      if (!channel || !channel.isTextBased()) {
        throw new Error('Channel is not a text-based channel or does not exist.');
      }

      await sendMessageInChunks(channel as TextChannel, messageContent, null, files);
    } catch (error) {
      throw new Error(`Error sending message: ${error}`);
    }
  }

  /**
   * Play an audio stream from a given response stream using the provided VoiceConnection.
   *
   * @param {any} responseStream - The response stream to play as audio.
   * @param {VoiceConnection} connection - The VoiceConnection to use for playing the audio.
   * @returns {Promise<void>} - A Promise that resolves when the TTS playback is finished.
   */
  async playAudioStream(responseStream: any, connection: VoiceConnection) {
    const audioPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });

    const audioResource = createAudioResource(responseStream);

    audioPlayer.play(audioResource);
    connection.subscribe(audioPlayer);

    logger.success('TTS playback started successfully.');

    await new Promise<void>((resolve, reject) => {
      audioPlayer.once(AudioPlayerStatus.Idle, () => {
        logger.info('TTS playback finished.');
        resolve();
      });

      audioPlayer.once('error', (error) => {
        reject(error);
        throw new Error(`TTS playback error: ${error}`);
      });
    });
  }

  /**
   * Retrieves the active guild where the bot is currently connected to a voice channel.
   *
   * @param {DiscordService} discordClient The DiscordService instance used to interact with the Discord API.
   * @returns {Promise<Guild>} The active guild where the bot is currently connected to a voice channel.
   * @throws {Error} If no active voice connection is found for the bot.
   */
  async getActiveGuild(discordClient: DiscordService) {
    const guilds = await discordClient.client.guilds.fetch();
    const fullGuilds = await Promise.all(guilds.map((guild) => guild.fetch())); // Fetch full guild data

    const activeGuild = fullGuilds.find((g) => g.members.me?.voice.channelId);
    if (!activeGuild) {
      throw new Error('No active voice connection found for the bot.');
    }
    return activeGuild;
  }

  /**
   * Waits for the VoiceManager in the Discord client to be ready.
   *
   * @param {DiscordService} discordClient - The Discord client to check for VoiceManager readiness.
   * @throws {Error} If the Discord client is not initialized.
   * @returns {Promise<void>} A promise that resolves when the VoiceManager is ready.
   */
  private async waitForVoiceManagerReady(discordClient: DiscordService) {
    if (!discordClient) {
      throw new Error('Discord client is not initialized.');
    }

    if (!discordClient.voiceManager.isReady()) {
      await new Promise<void>((resolve, reject) => {
        discordClient.voiceManager.once('ready', resolve);
        discordClient.voiceManager.once('error', reject);
      });
    }
  }

  /**
   * Validates the Discord test channel ID by checking if it is set in the runtime or environment variables.
   * If the test channel ID is not set, an error is thrown.
   *
   * @param {IAgentRuntime} runtime The runtime object containing the settings and environment variables.
   * @returns {string} The validated Discord test channel ID.
   */
  private validateChannelId(runtime: IAgentRuntime) {
    const testChannelId =
      runtime.getSetting('DISCORD_TEST_CHANNEL_ID') || process.env.DISCORD_TEST_CHANNEL_ID;
    if (!testChannelId) {
      throw new Error(
        'DISCORD_TEST_CHANNEL_ID is not set. Please provide a valid channel ID in the environment variables.'
      );
    }
    return testChannelId;
  }
}
