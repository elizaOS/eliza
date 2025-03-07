import {
	AudioPlayerStatus,
	NoSubscriberBehavior,
	VoiceConnectionStatus,
	createAudioPlayer,
	createAudioResource,
	entersState,
	type VoiceConnection,
} from "@discordjs/voice";
import {
	ModelTypes,
	logger,
	type IAgentRuntime,
	type TestSuite,
} from "@elizaos/core";
import { ChannelType, Events, type TextChannel } from "discord.js";
import type { DiscordService } from "./index.ts";
import { ServiceTypes } from "./types.ts";
import { sendMessageInChunks } from "./utils.ts";

const TEST_IMAGE_URL =
	"https://github.com/elizaOS/awesome-eliza/blob/main/assets/eliza-logo.jpg?raw=true";

export class DiscordTestSuite implements TestSuite {
	name = "discord";
	private discordClient: DiscordService | null = null;
	tests: { name: string; fn: (runtime: IAgentRuntime) => Promise<void> }[];

	constructor() {
		this.tests = [
			{
				name: "Initialize Discord Client",
				fn: this.testCreatingDiscordClient.bind(this),
			},
			{
				name: "Slash Commands - Join Voice",
				fn: this.testJoinVoiceSlashCommand.bind(this),
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
			{
				name: "Slash Commands - Leave Voice",
				fn: this.testLeaveVoiceSlashCommand.bind(this),
			},
		];
	}

	async testCreatingDiscordClient(runtime: IAgentRuntime) {
		try {
			this.discordClient = runtime.getService(
				ServiceTypes.DISCORD,
			) as DiscordService;

			// Wait for the bot to be ready before proceeding
			if (this.discordClient.client.isReady()) {
				logger.success("DiscordService is already ready.");
			} else {
				logger.info("Waiting for DiscordService to be ready...");
				await new Promise((resolve, reject) => {
					this.discordClient.client.once(Events.ClientReady, resolve);
					this.discordClient.client.once(Events.Error, reject);
				});
			}
		} catch (error) {
			throw new Error(`Error in test creating Discord client: ${error}`);
		}
	}

	async testJoinVoiceSlashCommand(runtime: IAgentRuntime) {
		try {
			await this.waitForVoiceManagerReady(this.discordClient);

			const channel = await this.getTestChannel(runtime);
			if (!channel || !channel.isTextBased()) {
				throw new Error("Invalid test channel for slash command test.");
			}

			// Simulate a join channel slash command interaction
			const fakeJoinInteraction = {
				isCommand: () => true,
				commandName: "joinchannel",
				options: {
					get: (name: string) =>
						name === "channel" ? { value: channel.id } : null,
				},
				guild: (channel as TextChannel).guild,
				deferReply: async () => {},
				editReply: async (message: string) => {
					logger.info(`JoinChannel Slash Command Response: ${message}`);
				},
			};

			await this.discordClient.voiceManager.handleJoinChannelCommand(
				fakeJoinInteraction as any,
			);

			logger.success("Slash command test completed successfully.");
		} catch (error) {
			throw new Error(`Error in slash commands test: ${error}`);
		}
	}

	async testLeaveVoiceSlashCommand(runtime: IAgentRuntime) {
		try {
			await this.waitForVoiceManagerReady(this.discordClient);

			const channel = await this.getTestChannel(runtime);
			if (!channel || !channel.isTextBased()) {
				throw new Error("Invalid test channel for slash command test.");
			}

			// Simulate a leave channel slash command interaction
			const fakeLeaveInteraction = {
				isCommand: () => true,
				commandName: "leavechannel",
				guildId: (channel as TextChannel).guildId,
				reply: async (message: string) => {
					logger.info(`LeaveChannel Slash Command Response: ${message}`);
				},
			};

			await this.discordClient.voiceManager.handleLeaveChannelCommand(
				fakeLeaveInteraction as any,
			);

			logger.success("Slash command test completed successfully.");
		} catch (error) {
			throw new Error(`Error in slash commands test: ${error}`);
		}
	}

	async testTextToSpeechPlayback(runtime: IAgentRuntime) {
		try {
			await this.waitForVoiceManagerReady(this.discordClient);

			const channel = await this.getTestChannel(runtime);
			if (!channel || channel.type !== ChannelType.GuildVoice) {
				throw new Error("Invalid voice channel.");
			}

			await this.discordClient.voiceManager.joinChannel(channel);

			const guild = await this.getActiveGuild(this.discordClient);
			const guildId = guild.id;
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
					ModelTypes.TEXT_TO_SPEECH,
					`Hi! I'm ${runtime.character.name}! How are you doing today?`,
				);
			} catch (_error) {
				throw new Error("No text to speech service found");
			}

			if (!responseStream) {
				throw new Error("TTS response stream is null or undefined.");
			}

			await this.playAudioStream(responseStream, connection);
		} catch (error) {
			throw new Error(`Error in TTS playback test: ${error}`);
		}
	}

	async testSendingTextMessage(runtime: IAgentRuntime) {
		try {
			const channel = await this.getTestChannel(runtime);

			await this.sendMessageToChannel(
				channel as TextChannel,
				"Testing Message",
				[TEST_IMAGE_URL],
			);
		} catch (error) {
			throw new Error(`Error in sending text message: ${error}`);
		}
	}

	async testHandlingMessage(runtime: IAgentRuntime) {
		try {
			const channel = await this.getTestChannel(runtime);

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

	// #############################
	//     Utility Functions
	// #############################

	async getTestChannel(runtime: IAgentRuntime) {
		const channelId = this.validateChannelId(runtime);
		const channel = await this.discordClient.client.channels.fetch(channelId);

		if (!channel) throw new Error("no test channel found!");

		return channel;
	}

	async sendMessageToChannel(
		channel: TextChannel,
		messageContent: string,
		files: any[],
	) {
		try {
			if (!channel || !channel.isTextBased()) {
				throw new Error(
					"Channel is not a text-based channel or does not exist.",
				);
			}

			await sendMessageInChunks(
				channel as TextChannel,
				messageContent,
				null,
				files,
			);
		} catch (error) {
			throw new Error(`Error sending message: ${error}`);
		}
	}

	async playAudioStream(responseStream: any, connection: VoiceConnection) {
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
	}

	async getActiveGuild(discordClient: DiscordService) {
		const guilds = await discordClient.client.guilds.fetch();
		const fullGuilds = await Promise.all(guilds.map((guild) => guild.fetch())); // Fetch full guild data

		const activeGuild = fullGuilds.find((g) => g.members.me?.voice.channelId);
		if (!activeGuild) {
			throw new Error("No active voice connection found for the bot.");
		}
		return activeGuild;
	}

	private async waitForVoiceManagerReady(discordClient: DiscordService) {
		if (!discordClient) {
			throw new Error("Discord client is not initialized.");
		}

		if (!discordClient.voiceManager.isReady()) {
			await new Promise<void>((resolve, reject) => {
				discordClient.voiceManager.once("ready", resolve);
				discordClient.voiceManager.once("error", reject);
			});
		}
	}

	private validateChannelId(runtime: IAgentRuntime) {
		const testChannelId =
			runtime.getSetting("DISCORD_TEST_CHANNEL_ID") ||
			process.env.DISCORD_TEST_CHANNEL_ID;
		if (!testChannelId) {
			throw new Error(
				"DISCORD_TEST_CHANNEL_ID is not set. Please provide a valid channel ID in the environment variables.",
			);
		}
		return testChannelId;
	}
}
