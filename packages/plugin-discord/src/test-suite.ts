import {
  logger,
  type TestSuite,
  type IAgentRuntime,
  ModelClass,
} from "@elizaos/core";
import { DiscordClient } from "./index.ts";
import { DiscordConfig, validateDiscordConfig } from "./environment";
import { sendMessageInChunks } from "./utils.ts";
import { ChannelType, Events, TextChannel } from "discord.js";
import {
  createAudioPlayer,
  NoSubscriberBehavior,
  createAudioResource,
  AudioPlayerStatus,
} from "@discordjs/voice";

export class DiscordTestSuite implements TestSuite {
  name = "discord";
  private discordClient: DiscordClient | null = null;
  tests: { name: string; fn: (runtime: IAgentRuntime) => Promise<void> }[];

  constructor() {
    this.tests = [
      {
        name: "test creating discord client",
        fn: this.testCreatingDiscordClient.bind(this),
      },
      {
        name: "test joining voice channel",
        fn: this.testJoiningVoiceChannel.bind(this),
      },
      {
        name: "test text-to-speech playback",
        fn: this.testTextToSpeechPlayback.bind(this),
      },
      {
        name: "test sending message with files",
        fn: this.testSendingTextMessage.bind(this),
      },
      {
        name: "handle message in message manager",
        fn: this.testHandlingMessage.bind(this),
      },
    ];
  }

  async testCreatingDiscordClient(runtime: IAgentRuntime) {
    try {
      const existingPlugin = runtime.getClient("discord");

      if (existingPlugin) {
        // Reuse the existing DiscordClient if available
        this.discordClient = existingPlugin as DiscordClient;
        logger.info("Reusing existing DiscordClient instance.");
      } else {
        if (!this.discordClient) {
          const discordConfig: DiscordConfig = await validateDiscordConfig(
            runtime
          );
          this.discordClient = new DiscordClient(runtime, discordConfig);
          await new Promise((resolve, reject) => {
            this.discordClient.client.once(Events.ClientReady, resolve);
            this.discordClient.client.once(Events.Error, reject);
          });
        } else {
          logger.info("Reusing existing DiscordClient instance.");
        }
        logger.success("DiscordClient successfully initialized.");
      }
    } catch (error) {
      throw new Error(`Error in test creating Discord client: ${error}`);
    }
  }

  async testJoiningVoiceChannel(runtime: IAgentRuntime) {
    try {
      let voiceChannel = null;
      let channelId = process.env.DISCORD_VOICE_CHANNEL_ID || null;

      if (!channelId) {
        const guilds = await this.discordClient.client.guilds.fetch();
        for (const [, guild] of guilds) {
          const fullGuild = await guild.fetch();
          const voiceChannels = fullGuild.channels.cache
            .filter((c) => c.type === ChannelType.GuildVoice)
            .values();
          voiceChannel = voiceChannels.next().value;
          if (voiceChannel) break;
        }

        if (!voiceChannel) {
          logger.warn("No suitable voice channel found to join.");
          return;
        }
      } else {
        voiceChannel = await this.discordClient.client.channels.fetch(
          channelId
        );
      }

      if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
        logger.error("Invalid voice channel.");
        return;
      }

      await this.discordClient.voiceManager.joinChannel(voiceChannel);

      logger.success(`Joined voice channel: ${voiceChannel.id}`);
    } catch (error) {
      logger.error("Error joining voice channel:", error);
    }
  }

  async testTextToSpeechPlayback(runtime: IAgentRuntime) {
    try {
      let guildId = this.discordClient.client.guilds.cache.find(
        (guild) => guild.members.me?.voice.channelId
      )?.id;

      if (!guildId) {
        logger.warn(
          "Bot is not connected to a voice channel. Attempting to join one..."
        );

        await this.testJoiningVoiceChannel(runtime);

        guildId = this.discordClient.client.guilds.cache.find(
          (guild) => guild.members.me?.voice.channelId
        )?.id;

        if (!guildId) {
          logger.error("Failed to join a voice channel. TTS playback aborted.");
          return;
        }
      }

      const connection =
        this.discordClient.voiceManager.getVoiceConnection(guildId);
      if (!connection) {
        logger.warn("No active voice connection found for the bot.");
        return;
      }

      let responseStream = null;
      try {
        responseStream = await runtime.useModel(
          ModelClass.TEXT_TO_SPEECH,
          `Hi! I'm ${runtime.character.name}! How are you doing today?`
        );
      } catch(error) {
        logger.warn("No text to speech service found");
        return;
      }
      

      if (!responseStream) {
        logger.error("TTS response stream is null or undefined.");
        return;
      }

      const audioPlayer = createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Pause,
        },
      });

      const audioResource = createAudioResource(responseStream);

      audioPlayer.play(audioResource);
      connection.subscribe(audioPlayer);

      logger.success("TTS playback started successfully.");

      await new Promise<void>((resolve, reject) => {
        audioPlayer.once(AudioPlayerStatus.Idle, () => {
          logger.info("TTS playback finished.");
          resolve();
        });

        audioPlayer.once("error", (error) => {
          logger.error("TTS playback error:", error);
          reject(error);
        });
      });
    } catch (error) {
      logger.error("Error in TTS playback test:", error);
    }
  }

  async testSendingTextMessage(runtime: IAgentRuntime) {
    try {
      const channel = await this.getTextChannel();
      if (!channel) return;

      await this.sendMessageToChannel(
        channel, 
        "Testing Message",
        ["https://github.com/elizaOS/awesome-eliza/blob/main/assets/eliza-logo.jpg"]
      );
    } catch (error) {
      logger.error("Error in sending text message:", error);
    }
  }

  async testHandlingMessage(runtime: IAgentRuntime) {
    try {
      const channel = await this.getTextChannel();
      if (!channel) return;

      const fakeMessage = {
        content: `Hello, ${runtime.character.name}! How are you?`,
        author: {
          id: "mock-user-id",
          username: "MockUser",
          bot: false,
        },
        channel,
        id: "mock-message-id",
        createdTimestamp: Date.now(),
        mentions: {
          has: () => false,
        },
        reference: null,
        attachments: [],
      };
      await this.discordClient.messageManager.handleMessage(fakeMessage as any);
  
    } catch (error) {
      logger.error("Error in sending text message:", error);
    }
  }


  async getTextChannel(): Promise<TextChannel | null> {
    try {
      let channel: TextChannel | null = null;
      const channelId = process.env.DISCORD_TEXT_CHANNEL_ID || null;
  
      if (!channelId) {
        const guilds = await this.discordClient.client.guilds.fetch();
        for (const [, guild] of guilds) {
          const fullGuild = await guild.fetch();
          const textChannels = fullGuild.channels.cache
            .filter((c) => c.type === ChannelType.GuildText)
            .values();
          channel = textChannels.next().value as TextChannel;
          if (channel) break; // Stop if we found a valid channel
        }
  
        if (!channel) {
          logger.warn("No suitable text channel found.");
          return null;
        }
      } else {
        const fetchedChannel = await this.discordClient.client.channels.fetch(channelId);
        if (fetchedChannel && fetchedChannel.isTextBased()) {
          channel = fetchedChannel as TextChannel;
        } else {
          logger.warn(`Provided channel ID (${channelId}) is invalid or not a text channel.`);
          return null;
        }
      }
  
      if (!channel) {
        logger.warn("Failed to determine a valid text channel.");
        return null;
      }
  
      return channel;
    } catch (error) {
      logger.error("Error fetching text channel:", error);
      return null;
    }
  }
  

  async sendMessageToChannel(channel: TextChannel, messageContent: string, files: any[]) {
    try {
      if (!channel || !channel.isTextBased()) {
        logger.error("Channel is not a text-based channel or does not exist.");
        return;
      }

      await sendMessageInChunks(
        channel as TextChannel,
        messageContent,
        null,
        files
      );
    } catch (error) {
      logger.error("Error sending message:", error);
    }
  }
}
