import {
  logger,
  type TestSuite,
  type IAgentRuntime,
  ModelClass,
} from "@elizaos/core";
import { DiscordClient } from "./index.ts";
import { sendMessageInChunks } from "./utils.ts";
import { ChannelType, Events, type TextChannel } from "discord.js";
import {
  createAudioPlayer,
  NoSubscriberBehavior,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} from "@discordjs/voice";

export class DiscordTestSuite implements TestSuite {
  name = "discord";
  private discordClient: DiscordClient | null = null;
  tests: { name: string; fn: (runtime: IAgentRuntime) => Promise<void> }[];

  constructor() {
    this.tests = [
      {
        name: "Initialize Discord Client",
        fn: this.testCreatingDiscordClient.bind(this),
      },
      {
        name: "Voice Playback & TTS",
        fn: this.testTextToSpeechPlayback.bind(this),
      },
      {
        name: "Send Message with Attachments",
        fn: this.testSendingTextMessage.bind(this),
      },
      {
        name: "Handle Incoming Messages",
        fn: this.testHandlingMessage.bind(this),
      },
    ];
  }

  async testCreatingDiscordClient(runtime: IAgentRuntime) {
    try {
      this.discordClient = runtime.getClient("discord") as DiscordClient;

      // Wait for the bot to be ready before proceeding
      if (this.discordClient.client.isReady()) {
        logger.success("DiscordClient is already ready.");
      } else {
        logger.info("Waiting for DiscordClient to be ready...");
        await new Promise((resolve, reject) => {
          this.discordClient.client.once(Events.ClientReady, resolve);
          this.discordClient.client.once(Events.Error, reject);
        });
      }
    } catch (error) {
      throw new Error(`Error in test creating Discord client: ${error}`);
    }
  }

  async testTextToSpeechPlayback(runtime: IAgentRuntime) {
    try {
      if (!this.discordClient.voiceManager.isReady()) {
        await new Promise<void>((resolve, reject) => {
          this.discordClient.voiceManager.once("ready", resolve);
          this.discordClient.voiceManager.once("error", reject);
        });
      }

      const guilds = await this.discordClient.client.guilds.fetch();
      const fullGuilds = await Promise.all(
        guilds.map((guild) => guild.fetch())
      ); // Fetch full guild data

      const activeGuild = fullGuilds.find((g) => g.members.me?.voice.channelId);
      if (!activeGuild) {
        throw new Error("No active voice connection found for the bot.");
      }

      const guildId = activeGuild.id;
      const connection =
        this.discordClient.voiceManager.getVoiceConnection(guildId);

      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
        logger.success(`Voice connection is ready in guild: ${guildId}`);
      } catch (error) {
        throw new Error(`Voice connection failed to become ready: ${error}`);
      }

      let responseStream = null;

      try {
        responseStream = await runtime.useModel(
          ModelClass.TEXT_TO_SPEECH,
          `Hi! I'm ${runtime.character.name}! How are you doing today?`
        );
      } catch (error) {
        throw new Error("No text to speech service found");
      }

      if (!responseStream) {
        throw new Error("TTS response stream is null or undefined.");
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
          reject(error);
          throw new Error(`TTS playback error: ${error}`);
        });
      });
    } catch (error) {
      throw new Error(`Error in TTS playback test: ${error}`);
    }
  }

  async testSendingTextMessage(runtime: IAgentRuntime) {
    try {
      const channel = await this.getTextChannel();
      if (!channel) return;

      await this.sendMessageToChannel(channel, "Testing Message", [
        "https://github.com/elizaOS/awesome-eliza/blob/main/assets/eliza-logo.jpg",
      ]);
    } catch (error) {
      throw new Error(`Error in sending text message: ${error}`);
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
      throw new Error(`Error in sending text message: ${error}`);
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
        const fetchedChannel = await this.discordClient.client.channels.fetch(
          channelId
        );
        if (fetchedChannel && fetchedChannel.isTextBased()) {
          channel = fetchedChannel as TextChannel;
        } else {
          logger.warn(
            `Provided channel ID (${channelId}) is invalid or not a text channel.`
          );
          return null;
        }
      }

      if (!channel) {
        logger.warn("Failed to determine a valid text channel.");
        return null;
      }

      return channel;
    } catch (error) {
      throw new Error(`Error fetching text channel: ${error}`);
    }
  }

  async sendMessageToChannel(
    channel: TextChannel,
    messageContent: string,
    files: any[]
  ) {
    try {
      if (!channel || !channel.isTextBased()) {
        throw new Error("Channel is not a text-based channel or does not exist.");
      }

      await sendMessageInChunks(
        channel as TextChannel,
        messageContent,
        null,
        files
      );
    } catch (error) {
      throw new Error(`Error sending message: ${error}`);
    }
  }
}
