/**
 * `VoiceManager` — the voice helper `DiscordService` delegates to for audio
 * receive/transmit over a joined voice channel: capturing member audio,
 * running it through STT, and playing generated audio back. Requires the
 * native opus/sodium deps and a system `ffmpeg`.
 */
import { EventEmitter } from "node:events";
import { pipeline, Readable, type Transform } from "node:stream";
import type {
	AudioPlayer,
	AudioReceiveStream,
	VoiceConnection,
} from "@discordjs/voice";
import {
	ChannelType,
	type Content,
	createUniqueUuid,
	type EventPayload,
	EventType,
	type HandlerCallback,
	logger,
	type Memory,
	ModelType,
	stringToUuid,
	type UUID,
} from "@elizaos/core";
import {
	type BaseGuildVoiceChannel,
	type Channel,
	type Client,
	ChannelType as DiscordChannelType,
	type Guild,
	type GuildMember,
	type VoiceState,
} from "discord.js";
import prism from "prism-media";
import {
	DEFAULT_DISCORD_AUDIO_LANES,
	type DiscordAudioLane,
	type DiscordAudioLaneConfig,
	getDiscordAudioLaneConfig,
	normalizeDiscordAudioLane,
} from "./audio-lanes";
import type {
	DiscordAudioPlaybackHandle,
	DiscordAudioSinkStatus,
} from "./audio-sink";
// See service.ts for detailed documentation on Discord ID handling.
// Key point: Discord snowflake IDs (e.g., "1253563208833433701") are NOT valid UUIDs.
// Use stringToUuid() to convert them, not asUUID() which would throw an error.
import type { ICompatRuntime } from "./compat";
import type { IDiscordService } from "./types";
import { getMessageService, normalizeDiscordMessageText } from "./utils";
import {
	DiscordVoiceMeetingSession,
	isVoiceTranscriptsSettingEnabled,
	loadDefaultVoiceMeetingDeps,
	type VoiceMeetingDeps,
} from "./voice-meetings";

// These values are chosen for compatibility with picovoice components
const DECODE_FRAME_SIZE = 1024;
const DECODE_SAMPLE_RATE = 16000;

type DiscordVoiceModule = typeof import("@discordjs/voice");

interface LanePlayerState {
	player: AudioPlayer;
	lane: DiscordAudioLane;
	guildId: string;
	channelId: string;
	finished: () => void;
	cancelled: () => void;
	abortController: AbortController;
	volume?: {
		setVolume(volume: number): void;
		volume?: number;
	};
	originalVolume?: number;
	duckedBy?: DiscordAudioLane;
}

let discordVoiceModulePromise: Promise<DiscordVoiceModule> | null = null;

class DiscordVoiceUnavailableError extends Error {
	override cause: unknown;

	constructor(cause: unknown) {
		const causeMessage =
			cause instanceof Error ? cause.message : String(cause ?? "unknown error");
		super(`Discord voice support is unavailable: ${causeMessage}`);
		this.name = "DiscordVoiceUnavailableError";
		this.cause = cause;
	}
}

export async function loadDiscordVoiceModule(): Promise<DiscordVoiceModule> {
	if (!discordVoiceModulePromise) {
		discordVoiceModulePromise = import("@discordjs/voice").catch((error) => {
			discordVoiceModulePromise = null;
			throw new DiscordVoiceUnavailableError(error);
		});
	}

	return discordVoiceModulePromise;
}

/**
 * Creates an opus decoder with fallback handling for different opus libraries
 * @param options - Decoder options including channels, rate, and frameSize
 * @returns An opus decoder instance or null if creation fails
 */
function createOpusDecoder(options: {
	channels: number;
	rate: number;
	frameSize: number;
}): Transform {
	try {
		// First try to create decoder with prism-media
		return new prism.opus.Decoder(options);
	} catch (error) {
		// Standalone function - no runtime context available
		logger.warn(
			{
				src: "plugin:discord:service:voice",
				error: error instanceof Error ? error.message : String(error),
			},
			"Failed to create opus decoder",
		);

		// Log available opus libraries for debugging
		void loadDiscordVoiceModule()
			.then(({ generateDependencyReport }) => {
				const report = generateDependencyReport();
				logger.debug(
					{ src: "plugin:discord:service:voice", report },
					"Voice dependency report",
				);
			})
			.catch((reportError) => {
				logger.warn(
					{
						src: "plugin:discord:service:voice",
						error:
							reportError instanceof Error
								? reportError.message
								: String(reportError),
					},
					"Could not generate dependency report",
				);
			});

		throw error;
	}
}

/**
 * Generates a WAV file header based on the provided audio parameters.
 * @param {number} audioLength - The length of the audio data in bytes.
 * @param {number} sampleRate - The sample rate of the audio.
 * @param {number} [channelCount=1] - The number of channels (default is 1).
 * @param {number} [bitsPerSample=16] - The number of bits per sample (default is 16).
 * @returns {Buffer} The WAV file header as a Buffer object.
 */
function getWavHeader(
	audioLength: number,
	sampleRate: number,
	channelCount = 1,
	bitsPerSample = 16,
): Buffer {
	const wavHeader = Buffer.alloc(44);
	wavHeader.write("RIFF", 0);
	wavHeader.writeUInt32LE(36 + audioLength, 4); // Length of entire file in bytes minus 8
	wavHeader.write("WAVE", 8);
	wavHeader.write("fmt ", 12);
	wavHeader.writeUInt32LE(16, 16); // Length of format data
	wavHeader.writeUInt16LE(1, 20); // Type of format (1 is PCM)
	wavHeader.writeUInt16LE(channelCount, 22); // Number of channels
	wavHeader.writeUInt32LE(sampleRate, 24); // Sample rate
	wavHeader.writeUInt32LE((sampleRate * bitsPerSample * channelCount) / 8, 28); // Byte rate
	wavHeader.writeUInt16LE((bitsPerSample * channelCount) / 8, 32); // Block align ((BitsPerSample * Channels) / 8)
	wavHeader.writeUInt16LE(bitsPerSample, 34); // Bits per sample
	wavHeader.write("data", 36); // Data chunk header
	wavHeader.writeUInt32LE(audioLength, 40); // Data chunk size
	return wavHeader;
}

/**
 * Class representing an AudioMonitor that listens for audio data from a Readable stream.
 */
export class AudioMonitor {
	private readable: Readable;
	private buffers: Buffer[] = [];
	private maxSize: number;
	private lastFlagged = -1;
	private ended = false;

	/**
	 * Constructs an AudioMonitor instance.
	 * @param {Readable} readable - The readable stream to monitor for audio data.
	 * @param {number} maxSize - The maximum size of the audio buffer.
	 * @param {function} onStart - The callback function to be called when audio starts.
	 * @param {function} callback - The callback function to process audio data.
	 */
	constructor(
		readable: Readable,
		maxSize: number,
		onStart: () => void,
		callback: (buffer: Buffer) => void,
	) {
		this.readable = readable;
		this.maxSize = maxSize;
		this.readable.on("data", (chunk: Buffer) => {
			if (this.lastFlagged < 0) {
				this.lastFlagged = this.buffers.length;
			}
			this.buffers.push(chunk);
			const currentSize = this.buffers.reduce(
				(acc, cur) => acc + cur.length,
				0,
			);
			while (currentSize > this.maxSize) {
				this.buffers.shift();
				this.lastFlagged--;
			}
		});
		this.readable.on("end", () => {
			logger.debug(
				{ src: "plugin:discord:service:voice" },
				"AudioMonitor ended",
			);
			this.ended = true;
			if (this.lastFlagged < 0) {
				return;
			}
			callback(this.getBufferFromStart());
			this.lastFlagged = -1;
		});
		this.readable.on("speakingStopped", () => {
			if (this.ended) {
				return;
			}
			logger.debug({ src: "plugin:discord:service:voice" }, "Speaking stopped");
			if (this.lastFlagged < 0) {
				return;
			}
			callback(this.getBufferFromStart());
		});
		this.readable.on("speakingStarted", () => {
			if (this.ended) {
				return;
			}
			onStart();
			logger.debug({ src: "plugin:discord:service:voice" }, "Speaking started");
			this.reset();
		});
	}

	/**
	 * Stops listening to "data", "end", "speakingStopped", and "speakingStarted" events on the readable stream.
	 */
	stop() {
		this.readable.removeAllListeners("data");
		this.readable.removeAllListeners("end");
		this.readable.removeAllListeners("speakingStopped");
		this.readable.removeAllListeners("speakingStarted");
	}

	/**
	 * Check if the item is flagged.
	 * @returns {boolean} True if the item was flagged, false otherwise.
	 */
	isFlagged() {
		return this.lastFlagged >= 0;
	}

	/**
	 * Returns a Buffer containing all buffers starting from the last flagged index.
	 * If the last flagged index is less than 0, returns null.
	 *
	 * @returns {Buffer | null} The concatenated Buffer or null
	 */
	getBufferFromFlag() {
		if (this.lastFlagged < 0) {
			return null;
		}
		const buffer = Buffer.concat(this.buffers.slice(this.lastFlagged));
		return buffer;
	}

	/**
	 * Concatenates all buffers in the array and returns a single buffer.
	 *
	 * @returns {Buffer} The concatenated buffer from the start.
	 */
	getBufferFromStart() {
		const buffer = Buffer.concat(this.buffers);
		return buffer;
	}

	/**
	 * Resets the buffers array and sets lastFlagged to -1.
	 */
	reset() {
		this.buffers = [];
		this.lastFlagged = -1;
	}

	/**
	 * Check if the object has ended.
	 * @returns {boolean} Returns true if the object has ended; false otherwise.
	 */
	isEnded() {
		return this.ended;
	}
}

/**
 * Class representing a VoiceManager that extends EventEmitter.
 * @extends EventEmitter
 */
export class VoiceManager extends EventEmitter {
	private processingVoice = false;
	private transcriptionTimeout: ReturnType<typeof setTimeout> | null = null;
	private userStates: Map<
		string,
		{
			buffers: Buffer[];
			totalLength: number;
			lastActive: number;
			transcriptionText: string;
		}
	> = new Map();
	private activeAudioPlayer: AudioPlayer | null = null;
	private client: Client | null;
	private runtime: ICompatRuntime;
	private accountId: string;
	private resolveDiscordEntityId?: (userId: string) => UUID;
	private registerVoiceTarget?: (target: {
		accountId: string;
		botId: string;
		botAlias?: string;
		channel: BaseGuildVoiceChannel;
		play: (
			stream: Readable,
			options?: {
				lane?: DiscordAudioLane;
				interrupt?: boolean;
				mix?: boolean;
				signal?: AbortSignal;
			},
		) => Promise<DiscordAudioPlaybackHandle>;
		stop: (lane?: DiscordAudioLane) => Promise<void>;
		getStatus: () => DiscordAudioSinkStatus;
		getLaneConfig: (lane?: DiscordAudioLane) => DiscordAudioLaneConfig;
	}) => void;
	private unregisterVoiceTarget?: (
		accountId: string,
		guildId: string,
		channelId: string,
	) => void;
	private isVoiceChannelClaimed?: (
		guildId: string,
		channelId: string,
	) => boolean;
	private streams: Map<string, Readable> = new Map();
	private connections: Map<string, VoiceConnection> = new Map();
	private audioLanes = new Map<string, DiscordAudioLaneConfig>();
	private lanePlayers = new Map<string, LanePlayerState>();
	private activeMonitors: Map<
		string,
		{ channel: BaseGuildVoiceChannel; monitor: AudioMonitor }
	> = new Map();
	private ready: boolean;
	/** channelId → live voice-channel transcription session. */
	private meetingSessions: Map<string, DiscordVoiceMeetingSession> = new Map();
	/** channelId → per-channel transcription override (slash command). */
	private transcriptionOverrides: Map<string, boolean> = new Map();
	/** Injectable for tests; defaults to the real plugin-meetings wiring. */
	meetingDepsLoader: (runtime: ICompatRuntime) => Promise<VoiceMeetingDeps> =
		loadDefaultVoiceMeetingDeps;

	/**
	 * Constructor for initializing a new instance of the class.
	 *
	 * @param {IDiscordService} service - The Discord service to use.
	 * @param {ICompatRuntime} runtime - The runtime for the agent (with cross-core compat).
	 */
	constructor(
		service: Pick<IDiscordService, "accountId" | "client"> & {
			resolveDiscordEntityId?: (userId: string) => UUID;
			registerVoiceTarget?: (target: {
				accountId: string;
				botId: string;
				botAlias?: string;
				channel: BaseGuildVoiceChannel;
				play: (
					stream: Readable,
					options?: {
						lane?: DiscordAudioLane;
						interrupt?: boolean;
						mix?: boolean;
						signal?: AbortSignal;
					},
				) => Promise<DiscordAudioPlaybackHandle>;
				stop: (lane?: DiscordAudioLane) => Promise<void>;
				getStatus: () => DiscordAudioSinkStatus;
				getLaneConfig: (lane?: DiscordAudioLane) => DiscordAudioLaneConfig;
			}) => void;
			unregisterVoiceTarget?: (
				accountId: string,
				guildId: string,
				channelId: string,
			) => void;
			isVoiceChannelClaimed?: (guildId: string, channelId: string) => boolean;
		},
		runtime: ICompatRuntime,
	) {
		super();
		this.client = service.client;
		this.runtime = runtime;
		this.accountId = service.accountId ?? "default";
		this.resolveDiscordEntityId = service.resolveDiscordEntityId;
		this.registerVoiceTarget = service.registerVoiceTarget;
		this.unregisterVoiceTarget = service.unregisterVoiceTarget;
		this.isVoiceChannelClaimed = service.isVoiceChannelClaimed;
		this.ready = false;
		for (const lane of Object.values(DEFAULT_DISCORD_AUDIO_LANES)) {
			this.audioLanes.set(lane.lane, lane);
		}

		if (this.client) {
			this.client.on("voiceManagerReady", () => {
				this.setReady(true);
			});
		} else {
			this.runtime.logger.error(
				{ src: "plugin:discord:service:voice", agentId: this.runtime.agentId },
				"Discord client not available for voiceManagerReady event",
			);
			this.ready = false;
		}
	}

	private resolveVoiceSpeakerEntityId(discordUserId: string): UUID {
		return (
			this.resolveDiscordEntityId?.(discordUserId) ??
			createUniqueUuid(this.runtime, discordUserId)
		);
	}

	/**
	 * Asynchronously retrieves the type of the channel.
	 * @param {Channel} channel - The channel to get the type for.
	 * @returns {Promise<ChannelType>} The type of the channel.
	 */
	async getChannelType(channel: Channel): Promise<ChannelType> {
		switch (channel.type) {
			case DiscordChannelType.GuildVoice:
			case DiscordChannelType.GuildStageVoice:
				return ChannelType.VOICE_GROUP;
			default:
				// This function should only be called with GuildVoice or GuildStageVoice channels
				// If it receives another type, it's an unexpected error.
				this.runtime.logger.error(
					{
						src: "plugin:discord:service:voice",
						agentId: this.runtime.agentId,
						channelId: channel.id,
						channelType: channel.type,
					},
					"Unexpected channel type",
				);
				throw new Error(`Unexpected channel type encountered: ${channel.type}`);
		}
	}

	/**
	 * Set the ready status of the VoiceManager.
	 * @param {boolean} status - The status to set.
	 */
	private setReady(status: boolean) {
		this.ready = status;
		this.emit("ready");
		this.runtime.logger.debug(
			{
				src: "plugin:discord:service:voice",
				agentId: this.runtime.agentId,
				ready: this.ready,
			},
			"VoiceManager ready status changed",
		);
	}

	/**
	 * Tears down active voice state so the Discord connector can unload cleanly.
	 */
	stop() {
		if (this.transcriptionTimeout) {
			clearTimeout(this.transcriptionTimeout);
			this.transcriptionTimeout = null;
		}

		for (const channelId of [...this.meetingSessions.keys()]) {
			void this.stopVoiceTranscription(channelId, "requested_stop");
		}

		for (const memberId of [...this.activeMonitors.keys()]) {
			this.stopMonitoringMember(memberId);
		}

		for (const connection of new Set(this.connections.values())) {
			try {
				connection.destroy();
			} catch (error) {
				this.runtime.logger.warn(
					{
						src: "plugin:discord:service:voice",
						agentId: this.runtime.agentId,
						error: error instanceof Error ? error.message : String(error),
					},
					"Failed to destroy Discord voice connection during shutdown",
				);
			}
		}

		this.connections.clear();
		this.streams.clear();
		for (const state of this.lanePlayers.values()) {
			this.cleanupAudioPlayer(state.player);
			state.abortController.abort();
		}
		this.lanePlayers.clear();
		this.userStates.clear();
		this.processingVoice = false;
		this.cleanupAudioPlayer(this.activeAudioPlayer);
		this.removeAllListeners();
		this.ready = false;
	}

	/**
	 * Check if the object is ready.
	 *
	 * @returns {boolean} True if the object is ready, false otherwise.
	 */
	isReady() {
		return this.ready;
	}

	/**
	 * Handle voice state update event.
	 * @param {VoiceState} oldState - The old voice state of the member.
	 * @param {VoiceState} newState - The new voice state of the member.
	 * @returns {void}
	 */
	async handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState) {
		const oldChannelId = oldState.channelId;
		const newChannelId = newState.channelId;
		const member = newState.member;
		if (!member) {
			return;
		}
		const clientUser = this.client?.user;
		if (clientUser && member.id === clientUser.id) {
			return;
		}

		// Ignore mute/unmute events
		if (oldChannelId === newChannelId) {
			return;
		}

		// User leaving a channel where the bot is present
		if (oldChannelId && this.connections.has(oldChannelId)) {
			this.stopMonitoringMember(member.id);
			this.meetingSessions.get(oldChannelId)?.participantLeft(member.id);
		}

		// User joining a channel where the bot is present
		if (newChannelId && this.connections.has(newChannelId)) {
			await this.monitorMember(
				member,
				newState.channel as BaseGuildVoiceChannel,
			);
			if (!member.user.bot) {
				this.meetingSessions
					.get(newChannelId)
					?.participantJoined(member.id, member.displayName);
			}
		}
	}

	/**
	 * Joins a voice channel and sets up the necessary connection and event listeners.
	 * @param {BaseGuildVoiceChannel} channel - The voice channel to join
	 */
	async joinChannel(channel: BaseGuildVoiceChannel) {
		const oldConnection = this.getVoiceConnection(channel.guildId as string);
		if (oldConnection) {
			try {
				const oldChannelId = oldConnection.joinConfig.channelId;
				oldConnection.destroy();
				if (oldChannelId) {
					this.unregisterVoiceTarget?.(
						this.accountId,
						channel.guild.id,
						oldChannelId,
					);
				}
				// Remove all associated streams and monitors
				this.streams.clear();
				this.activeMonitors.clear();
			} catch (error) {
				this.runtime.logger.error(
					{
						src: "plugin:discord:service:voice",
						agentId: this.runtime.agentId,
						error: error instanceof Error ? error.message : String(error),
					},
					"Error leaving voice channel",
				);
			}
		}

		const { entersState, joinVoiceChannel, VoiceConnectionStatus } =
			await loadDiscordVoiceModule();
		const connection = joinVoiceChannel({
			channelId: channel.id,
			guildId: channel.guild.id,
			adapterCreator: channel.guild.voiceAdapterCreator,
			selfDeaf: false,
			selfMute: false,
			group: this.client?.user?.id ?? "default-group",
		});

		try {
			// Wait for either Ready or Signalling state
			await Promise.race([
				entersState(connection, VoiceConnectionStatus.Ready, 20_000),
				entersState(connection, VoiceConnectionStatus.Signalling, 20_000),
			]);

			// Log connection success
			this.runtime.logger.info(
				{
					src: "plugin:discord:service:voice",
					agentId: this.runtime.agentId,
					status: connection.state.status,
				},
				"Voice connection established",
			);

			// Set up ongoing state change monitoring
			connection.on("stateChange", async (oldState, newState) => {
				this.runtime.logger.debug(
					{
						src: "plugin:discord:service:voice",
						agentId: this.runtime.agentId,
						oldState: oldState.status,
						newState: newState.status,
					},
					"Voice connection state changed",
				);

				if (newState.status === VoiceConnectionStatus.Disconnected) {
					this.runtime.logger.debug(
						{
							src: "plugin:discord:service:voice",
							agentId: this.runtime.agentId,
						},
						"Handling disconnection",
					);

					try {
						// Try to reconnect if disconnected
						await Promise.race([
							entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
							entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
						]);
						// Seems to be reconnecting to a new channel
						this.runtime.logger.debug(
							{
								src: "plugin:discord:service:voice",
								agentId: this.runtime.agentId,
							},
							"Reconnecting to channel",
						);
					} catch (e) {
						// Seems to be a real disconnect, destroy and cleanup
						this.runtime.logger.debug(
							{
								src: "plugin:discord:service:voice",
								agentId: this.runtime.agentId,
								error: e instanceof Error ? e.message : String(e),
							},
							"Disconnection confirmed - cleaning up",
						);
						connection.destroy();
						this.connections.delete(channel.id);
						this.unregisterVoiceTarget?.(
							this.accountId,
							channel.guild.id,
							channel.id,
						);
					}
				} else if (newState.status === VoiceConnectionStatus.Destroyed) {
					this.connections.delete(channel.id);
					this.unregisterVoiceTarget?.(
						this.accountId,
						channel.guild.id,
						channel.id,
					);
					void this.stopVoiceTranscription(channel.id, "normal_completion");
				} else if (
					!this.connections.has(channel.id) &&
					(newState.status === VoiceConnectionStatus.Ready ||
						newState.status === VoiceConnectionStatus.Signalling)
				) {
					this.connections.set(channel.id, connection);
				}
			});

			connection.on("error", (error) => {
				this.runtime.logger.error(
					{
						src: "plugin:discord:service:voice",
						agentId: this.runtime.agentId,
						error: error instanceof Error ? error.message : String(error),
					},
					"Voice connection error",
				);
				// Don't immediately destroy - let the state change handler deal with it
				this.runtime.logger.debug(
					{
						src: "plugin:discord:service:voice",
						agentId: this.runtime.agentId,
					},
					"Will attempt to recover",
				);
			});

			// Store the connection
			this.connections.set(channel.id, connection);
			const botId = this.client?.user?.id;
			if (botId) {
				this.registerVoiceTarget?.({
					accountId: this.accountId,
					botId,
					botAlias: this.accountId,
					channel,
					play: (stream, options) =>
						this.playAudio(stream, {
							...options,
							guildId: channel.guild.id,
							channelId: channel.id,
						}),
					stop: (lane) => this.stopAudio(channel.guild.id, lane),
					getStatus: () =>
						this.getVoiceConnection(channel.guild.id)
							? "connected"
							: "disconnected",
					getLaneConfig: (lane) => this.getAudioLaneConfig(lane),
				});
			}

			// Voice-channel transcription (DISCORD_VOICE_TRANSCRIPTS / /transcribe)
			if (this.isVoiceTranscriptionEnabled(channel.id)) {
				void this.startVoiceTranscription(channel).catch((error) => {
					this.runtime.logger.error(
						{
							src: "plugin:discord:voice:meetings",
							agentId: this.runtime.agentId,
							channelId: channel.id,
							error: error instanceof Error ? error.message : String(error),
						},
						"[DiscordVoiceMeetings] failed to start voice transcription session",
					);
				});
			}

			// Continue with voice state modifications
			const me = channel.guild.members.me;
			const meVoice = me?.voice;
			if (meVoice && me.permissions.has("DeafenMembers")) {
				try {
					await meVoice.setDeaf(false);
					await meVoice.setMute(false);
				} catch (error) {
					this.runtime.logger.warn(
						{
							src: "plugin:discord:service:voice",
							agentId: this.runtime.agentId,
							error: error instanceof Error ? error.message : String(error),
						},
						"Failed to modify voice state",
					);
					// Continue even if this fails
				}
			}

			connection.receiver.speaking.on("start", async (entityId: string) => {
				let user = channel.members.get(entityId);
				if (!user) {
					try {
						user = await channel.guild.members.fetch(entityId);
					} catch (error) {
						this.runtime.logger.error(
							{
								src: "plugin:discord:service:voice",
								agentId: this.runtime.agentId,
								entityId,
								error: error instanceof Error ? error.message : String(error),
							},
							"Failed to fetch user",
						);
					}
				}

				const userUser = user?.user;
				if (user && userUser && !userUser.bot) {
					this.monitorMember(user as GuildMember, channel);
					const entityStream = this.streams.get(entityId);
					if (entityStream) {
						entityStream.emit("speakingStarted");
					}
				}
			});

			connection.receiver.speaking.on("end", async (entityId: string) => {
				const user = channel.members.get(entityId);
				const userUser = user?.user;
				if (user && userUser && !userUser.bot) {
					const entityStream = this.streams.get(entityId);
					if (entityStream) {
						entityStream.emit("speakingStopped");
					}
					// Speaking end = utterance boundary for the meeting pipeline.
					this.meetingSessions.get(channel.id)?.flushSpeaker(entityId);
				}
			});
		} catch (error) {
			this.runtime.logger.error(
				{
					src: "plugin:discord:service:voice",
					agentId: this.runtime.agentId,
					channelId: channel.id,
					error: error instanceof Error ? error.message : String(error),
				},
				"Failed to establish voice connection",
			);
			connection.destroy();
			this.connections.delete(channel.id);
			throw error;
		}
	}

	/**
	 * Retrieves the voice connection for a given guild ID.
	 * @param {string} guildId - The ID of the guild to get the voice connection for.
	 * @returns {VoiceConnection | undefined} The voice connection for the specified guild ID, or undefined if not found.
	 */
	getVoiceConnection(guildId: string) {
		return [...new Set(this.connections.values())].find(
			(connection) => connection.joinConfig.guildId === guildId,
		);
	}

	/**
	 * Whether voice-channel transcription should run for a channel: a per-join
	 * override (set by the /transcribe slash command) wins, else the global
	 * DISCORD_VOICE_TRANSCRIPTS setting (off by default).
	 */
	isVoiceTranscriptionEnabled(channelId: string): boolean {
		const override = this.transcriptionOverrides.get(channelId);
		if (override !== undefined) {
			return override;
		}
		return isVoiceTranscriptsSettingEnabled(this.runtime);
	}

	/** Per-channel opt in/out of voice transcription (slash command surface). */
	setVoiceTranscriptionOverride(channelId: string, enabled: boolean): void {
		this.transcriptionOverrides.set(channelId, enabled);
	}

	getMeetingSession(channelId: string): DiscordVoiceMeetingSession | undefined {
		return this.meetingSessions.get(channelId);
	}

	/**
	 * Start a meeting transcription session for a voice channel the bot is
	 * connected to. Idempotent per channel — returns the live session if one
	 * already exists.
	 */
	async startVoiceTranscription(
		channel: BaseGuildVoiceChannel,
	): Promise<DiscordVoiceMeetingSession> {
		const existing = this.meetingSessions.get(channel.id);
		if (existing?.active) {
			return existing;
		}
		const deps = await this.meetingDepsLoader(this.runtime);
		const clientUserId = this.client?.user?.id;
		const members = [...channel.members.values()]
			.filter((member) => !member.user.bot && member.id !== clientUserId)
			.map((member) => ({ id: member.id, displayName: member.displayName }));
		const session = new DiscordVoiceMeetingSession({
			runtime: this.runtime,
			channel: {
				channelId: channel.id,
				channelName: channel.name,
				guildId: channel.guild.id,
				guildName: channel.guild.name,
				members,
			},
			deps,
		});
		this.meetingSessions.set(channel.id, session);
		try {
			await session.start();
		} catch (error) {
			this.meetingSessions.delete(channel.id);
			throw error;
		}
		return session;
	}

	/**
	 * Finalize and remove the meeting session for a channel (no-op when none
	 * is running). Finalization errors are logged, never thrown — this runs on
	 * teardown paths (leave, disconnect, shutdown) that must not fail.
	 */
	async stopVoiceTranscription(
		channelId: string,
		endReason: Parameters<DiscordVoiceMeetingSession["stop"]>[0],
	): Promise<void> {
		const session = this.meetingSessions.get(channelId);
		if (!session) {
			return;
		}
		this.meetingSessions.delete(channelId);
		try {
			await session.stop(endReason);
		} catch (error) {
			this.runtime.logger.error(
				{
					src: "plugin:discord:voice:meetings",
					agentId: this.runtime.agentId,
					channelId,
					sessionId: session.sessionId,
					error: error instanceof Error ? error.message : String(error),
				},
				"[DiscordVoiceMeetings] failed to finalize voice transcription session",
			);
		}
	}

	/**
	 * Monitor a member's audio stream for volume activity and speaking thresholds.
	 *
	 * @param {GuildMember} member - The member whose audio stream is being monitored.
	 * @param {BaseGuildVoiceChannel} channel - The voice channel in which the member is connected.
	 */
	private async monitorMember(
		member: GuildMember,
		channel: BaseGuildVoiceChannel,
	) {
		const entityId = member?.id;
		const memberUser = member?.user;
		const userName = memberUser?.username;
		const name = memberUser?.displayName;
		const memberGuild = member?.guild;
		const memberGuildId = memberGuild?.id;
		const connection = this.getVoiceConnection(memberGuildId);

		const connectionReceiver = connection?.receiver;
		const receiveStream = connectionReceiver?.subscribe(entityId, {
			autoDestroy: true,
			emitClose: true,
		});
		if (!receiveStream || receiveStream.readableLength === 0) {
			this.runtime.logger.warn(
				{
					src: "plugin:discord:service:voice",
					agentId: this.runtime.agentId,
					entityId,
				},
				"No receiveStream or empty stream",
			);
			return;
		}

		let opusDecoder: ReturnType<typeof createOpusDecoder>;
		try {
			// Try to create opus decoder with error handling for Node.js 23 compatibility
			opusDecoder = createOpusDecoder({
				channels: 1,
				rate: DECODE_SAMPLE_RATE,
				frameSize: DECODE_FRAME_SIZE,
			});
		} catch (error) {
			this.runtime.logger.error(
				{
					src: "plugin:discord:service:voice",
					agentId: this.runtime.agentId,
					entityId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Failed to create opus decoder",
			);
			return;
		}

		// Tee the single decoded PCM stream into the meeting transcription
		// session (when one is live for this channel). The decoder emits s16le
		// mono 16 kHz; the AudioMonitor (utterance→agent-reply path) attaches
		// its own "data" listener in handleUserStream — one decode, two
		// consumers, neither path re-decodes.
		const memberDisplayName = member?.displayName ?? userName;
		opusDecoder.on("data", (pcmData: Buffer) => {
			this.meetingSessions
				.get(channel.id)
				?.pushPcm(entityId, pcmData, memberDisplayName, DECODE_SAMPLE_RATE);
		});

		const volumeBuffer: number[] = [];
		const VOLUME_WINDOW_SIZE = 30;
		const SPEAKING_THRESHOLD = 0.05;
		opusDecoder.on("data", (pcmData: Buffer) => {
			// Monitor the audio volume while the agent is speaking.
			// If the average volume of the user's audio exceeds the defined threshold, it indicates active speaking.
			// When active speaking is detected, stop the agent's current audio playbook to avoid overlap.

			if (this.activeAudioPlayer) {
				const samples = new Int16Array(
					pcmData.buffer,
					pcmData.byteOffset,
					pcmData.length / 2,
				);
				const maxAmplitude = Math.max(...samples.map(Math.abs)) / 32768;
				volumeBuffer.push(maxAmplitude);

				if (volumeBuffer.length > VOLUME_WINDOW_SIZE) {
					volumeBuffer.shift();
				}
				const avgVolume =
					volumeBuffer.reduce((sum, v) => sum + v, 0) / VOLUME_WINDOW_SIZE;

				if (avgVolume > SPEAKING_THRESHOLD) {
					volumeBuffer.length = 0;
					this.cleanupAudioPlayer(this.activeAudioPlayer);
					this.processingVoice = false;
				}
			}
		});

		if (!opusDecoder) {
			this.runtime.logger.error(
				{
					src: "plugin:discord:service:voice",
					agentId: this.runtime.agentId,
				},
				"Opus decoder not available",
			);
			return;
		}
		pipeline(
			receiveStream as AudioReceiveStream,
			opusDecoder,
			(err: Error | null) => {
				if (err) {
					this.runtime.logger.debug(
						{
							src: "plugin:discord:service:voice",
							agentId: this.runtime.agentId,
							entityId,
							error: err.message,
						},
						"Opus decoding pipeline error",
					);
				} else {
					this.runtime.logger.debug(
						{
							src: "plugin:discord:service:voice",
							agentId: this.runtime.agentId,
							entityId,
						},
						"Opus decoding pipeline finished",
					);
				}
			},
		);
		this.streams.set(entityId, opusDecoder);
		this.connections.set(entityId, connection as VoiceConnection);
		opusDecoder.on("error", (err: Error) => {
			this.runtime.logger.debug(
				{
					src: "plugin:discord:service:voice",
					agentId: this.runtime.agentId,
					error: err instanceof Error ? err.message : String(err),
				},
				"Opus decoding error",
			);
		});
		const errorHandler = (err: Error) => {
			this.runtime.logger.debug(
				{
					src: "plugin:discord:service:voice",
					agentId: this.runtime.agentId,
					error: err instanceof Error ? err.message : String(err),
				},
				"Opus decoding error",
			);
		};
		const streamCloseHandler = () => {
			this.runtime.logger.debug(
				{
					src: "plugin:discord:service:voice",
					agentId: this.runtime.agentId,
					member: member?.displayName || undefined,
				},
				"Voice stream closed",
			);
			this.streams.delete(entityId);
			this.connections.delete(entityId);
		};
		const closeHandler = () => {
			this.runtime.logger.debug(
				{
					src: "plugin:discord:service:voice",
					agentId: this.runtime.agentId,
					member: member?.displayName || undefined,
				},
				"Opus decoder closed",
			);
			opusDecoder.removeListener("error", errorHandler);
			opusDecoder.removeListener("close", closeHandler);
			if (receiveStream) {
				receiveStream.removeListener("close", streamCloseHandler);
			}
		};
		opusDecoder.on("error", errorHandler);
		opusDecoder.on("close", closeHandler);
		if (receiveStream) {
			receiveStream.on("close", streamCloseHandler);
		}

		if (this.client) {
			this.client.emit(
				"userStream",
				entityId,
				name,
				userName,
				channel,
				opusDecoder,
			);
		}
	}

	/**
	 * Leaves the specified voice channel and stops monitoring all members in that channel.
	 * If there is an active connection in the channel, it will be destroyed.
	 *
	 * @param {BaseGuildVoiceChannel} channel - The voice channel to leave.
	 */
	leaveChannel(channel: BaseGuildVoiceChannel) {
		void this.stopVoiceTranscription(channel.id, "requested_stop");
		const connection = this.connections.get(channel.id);
		if (connection) {
			connection.destroy();
			this.connections.delete(channel.id);
		}
		this.unregisterVoiceTarget?.(this.accountId, channel.guild.id, channel.id);
		void this.stopAudio(channel.guild.id);

		// Stop monitoring all members in this channel
		for (const [memberId, monitorInfo] of this.activeMonitors) {
			if (
				monitorInfo.channel.id === channel.id &&
				memberId !== this.client?.user?.id
			) {
				this.stopMonitoringMember(memberId);
			}
		}

		this.runtime.logger.debug(
			{
				src: "plugin:discord:service:voice",
				agentId: this.runtime.agentId,
				channelId: channel.id,
				channelName: channel.name,
			},
			"Left voice channel",
		);
	}

	/**
	 * Stop monitoring a specific member by their member ID.
	 * @param {string} memberId - The ID of the member to stop monitoring.
	 */
	stopMonitoringMember(memberId: string) {
		const monitorInfo = this.activeMonitors.get(memberId);
		if (monitorInfo) {
			monitorInfo.monitor.stop();
			this.activeMonitors.delete(memberId);
			this.streams.delete(memberId);
			this.runtime.logger.debug(
				{
					src: "plugin:discord:service:voice",
					agentId: this.runtime.agentId,
					memberId,
				},
				"Stopped monitoring user",
			);
		}
	}

	/**
	 * Asynchronously debounces the process transcription function to prevent rapid execution.
	 *
	 * @param {string} entityId - The Discord user ID related to the transcription.
	 * @param {string} name - The name of the entity for transcription.
	 * @param {string} userName - The username of the user initiating the transcription.
	 * @param {BaseGuildVoiceChannel} channel - The voice channel where the transcription is happening.
	 */

	async debouncedProcessTranscription(
		entityId: string,
		name: string,
		userName: string,
		channel: BaseGuildVoiceChannel,
	) {
		const DEBOUNCE_TRANSCRIPTION_THRESHOLD = 1500; // wait for 1.5 seconds of silence

		const activeAudioPlayer = this.activeAudioPlayer;
		const activeAudioPlayerState = activeAudioPlayer?.state;
		if (activeAudioPlayerState && activeAudioPlayerState.status === "idle") {
			this.runtime.logger.debug(
				{ src: "plugin:discord:service:voice", agentId: this.runtime.agentId },
				"Cleaning up idle audio player",
			);
			this.cleanupAudioPlayer(this.activeAudioPlayer);
		}

		if (this.activeAudioPlayer || this.processingVoice) {
			const state = this.userStates.get(entityId);
			if (state) {
				state.buffers.length = 0;
				state.totalLength = 0;
			}
			return;
		}

		if (this.transcriptionTimeout) {
			clearTimeout(this.transcriptionTimeout);
		}

		this.transcriptionTimeout = setTimeout(async () => {
			this.processingVoice = true;
			try {
				await this.processTranscription(
					entityId,
					channel.id,
					channel,
					name,
					userName,
				);
			} finally {
				this.processingVoice = false;
			}
		}, DEBOUNCE_TRANSCRIPTION_THRESHOLD);
	}

	/**
	 * Handle user audio stream for monitoring purposes.
	 *
	 * @param {string} entityId - The Discord user ID.
	 * @param {string} name - The name of the user.
	 * @param {string} userName - The username of the user.
	 * @param {BaseGuildVoiceChannel} channel - The voice channel the user is in.
	 * @param {Readable} audioStream - The audio stream to monitor.
	 */
	async handleUserStream(
		entityId: string,
		name: string,
		userName: string,
		channel: BaseGuildVoiceChannel,
		audioStream: Readable,
	) {
		this.runtime.logger.debug(
			{
				src: "plugin:discord:service:voice",
				agentId: this.runtime.agentId,
				entityId,
			},
			"Starting audio monitor",
		);
		if (!this.userStates.has(entityId)) {
			this.userStates.set(entityId, {
				buffers: [],
				totalLength: 0,
				lastActive: Date.now(),
				transcriptionText: "",
			});
		}

		const state = this.userStates.get(entityId);

		const processBuffer = async (buffer: Buffer) => {
			try {
				if (state?.buffers) {
					state.buffers.push(buffer);
					state.totalLength += buffer.length;
				}
				if (state) {
					state.lastActive = Date.now();
				}
				this.debouncedProcessTranscription(entityId, name, userName, channel);
			} catch (error) {
				this.runtime.logger.error(
					{
						src: "plugin:discord:service:voice",
						agentId: this.runtime.agentId,
						entityId,
						error: error instanceof Error ? error.message : String(error),
					},
					"Error processing buffer",
				);
			}
		};

		new AudioMonitor(
			audioStream,
			10000000,
			() => {
				if (this.transcriptionTimeout) {
					clearTimeout(this.transcriptionTimeout);
				}
			},
			async (buffer) => {
				if (!buffer) {
					this.runtime.logger.error(
						{
							src: "plugin:discord:service:voice",
							agentId: this.runtime.agentId,
						},
						"Received empty buffer",
					);
					return;
				}
				await processBuffer(buffer);
			},
		);
	}

	/**
	 * Process the transcription of audio data for a user.
	 *
	 * @param {string} entityId - The Discord user ID.
	 * @param {string} channelId - The ID of the channel where the transcription is taking place.
	 * @param {BaseGuildVoiceChannel} channel - The voice channel where the user is speaking.
	 * @param {string} name - The name of the user.
	 * @param {string} userName - The username of the user.
	 * @returns {Promise<void>}
	 */
	private async processTranscription(
		entityId: string,
		channelId: string,
		channel: BaseGuildVoiceChannel,
		name: string,
		userName: string,
	) {
		const state = this.userStates.get(entityId);
		if (!state || state.buffers.length === 0) {
			return;
		}
		try {
			const inputBuffer = Buffer.concat(state.buffers, state.totalLength);

			state.buffers.length = 0; // Clear the buffers
			state.totalLength = 0;
			// Convert Opus to WAV
			const wavBuffer = await this.convertOpusToWav(inputBuffer);
			this.runtime.logger.debug(
				{ src: "plugin:discord:service:voice", agentId: this.runtime.agentId },
				"Starting transcription",
			);

			const transcriptionText = await this.runtime.useModel(
				ModelType.TRANSCRIPTION,
				wavBuffer,
			);
			function isValidTranscription(text: string): boolean {
				if (!text || text.includes("[BLANK_AUDIO]")) {
					return false;
				}
				return true;
			}

			if (transcriptionText && isValidTranscription(transcriptionText)) {
				state.transcriptionText += transcriptionText;
			}

			if (state.transcriptionText.length) {
				this.cleanupAudioPlayer(this.activeAudioPlayer);
				const finalText = state.transcriptionText;
				state.transcriptionText = "";
				await this.handleMessage(
					finalText,
					entityId,
					channelId,
					channel,
					name,
					userName,
				);
			}
		} catch (error) {
			this.runtime.logger.error(
				{
					src: "plugin:discord:service:voice",
					agentId: this.runtime.agentId,
					entityId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error transcribing audio",
			);
		}
	}

	/**
	 * Handles a voice message received in a Discord channel.
	 *
	 * @param {string} message - The message content.
	 * @param {string} entityId - The Discord user ID associated with the message.
	 * @param {string} channelId - The ID of the Discord channel where the message was received.
	 * @param {BaseGuildVoiceChannel} channel - The Discord channel where the message was received.
	 * @param {string} name - The name associated with the message.
	 * @param {string} userName - The user name associated with the message.
	 * @returns {Promise<{text: string, actions: string[]}>} Object containing the resulting text and actions.
	 */
	private async handleMessage(
		message: string,
		entityId: string,
		channelId: string,
		channel: BaseGuildVoiceChannel,
		name: string,
		userName: string,
	) {
		try {
			if (!message || message.trim() === "" || message.length < 3) {
				return { text: "", actions: ["IGNORE"] };
			}

			const roomId = createUniqueUuid(this.runtime, channelId);
			const uniqueEntityId = this.resolveVoiceSpeakerEntityId(entityId);
			const type = await this.getChannelType(channel as Channel);

			await this.runtime.ensureConnection({
				entityId: uniqueEntityId,
				roomId,
				roomName: channel.name,
				userName,
				name,
				source: "discord",
				channelId,
				// Convert Discord snowflake to UUID (see service.ts header for why stringToUuid not asUUID)
				messageServerId: stringToUuid(channel.guild.id),
				type,
				worldId: createUniqueUuid(this.runtime, channel.guild.id) as UUID,
				worldName: channel.guild.name,
				metadata: {
					accountId: this.accountId,
				},
			});

			const memory: Memory = {
				id: createUniqueUuid(
					this.runtime,
					`${channelId}-voice-message-${Date.now()}`,
				),
				agentId: this.runtime.agentId,
				entityId: uniqueEntityId,
				roomId,
				content: {
					text: message,
					source: "discord",
					url: channel.url,
					name,
					userName,
					isVoiceMessage: true,
					channelType: type,
				},
				metadata: {
					accountId: this.accountId,
				},
				createdAt: Date.now(),
			};

			const callback: HandlerCallback = async (
				content: Content,
				_actionName?: string,
			) => {
				try {
					const responseText = normalizeDiscordMessageText(content.text);
					const responseMemory: Memory = {
						id: createUniqueUuid(
							this.runtime,
							`${memory.id}-voice-response-${Date.now()}`,
						),
						entityId: this.runtime.agentId,
						agentId: this.runtime.agentId,
						content: {
							...content,
							text: responseText || undefined,
							name: this.runtime.character.name,
							inReplyTo: memory.id,
							isVoiceMessage: true,
							channelType: type,
						},
						roomId,
						metadata: {
							accountId: this.accountId,
						},
						createdAt: Date.now(),
					};

					const responseMemoryContentText = responseMemory.content.text;
					if (responseMemoryContentText?.trim()) {
						await this.runtime.createMemory(responseMemory, "messages");

						if (responseText) {
							const responseStream = await this.runtime.useModel(
								ModelType.TEXT_TO_SPEECH,
								responseText,
							);
							if (responseStream) {
								// Convert Buffer/ArrayBuffer to Readable stream
								const buffer = Buffer.isBuffer(responseStream)
									? responseStream
									: Buffer.from(responseStream as ArrayBuffer);
								const readable = Readable.from(buffer);
								await this.playAudioStream(entityId, readable);
							}
						}
					}

					return [responseMemory];
				} catch (error) {
					this.runtime.logger.error(
						{
							src: "plugin:discord:service:voice",
							agentId: this.runtime.agentId,
							error: error instanceof Error ? error.message : String(error),
						},
						"Error in voice message callback",
					);
					return [];
				}
			};

			// Voice messages follow the same default-off auto-reply policy as
			// text messages: ingestion happens via the memory created above,
			// but the agent only generates a spoken reply when DISCORD_AUTO_REPLY
			// is explicitly enabled.
			const voiceAutoReplyRaw = this.runtime.getSetting("DISCORD_AUTO_REPLY");
			const voiceAutoReply =
				voiceAutoReplyRaw === true || voiceAutoReplyRaw === "true";

			if (!voiceAutoReply) {
				this.runtime.logger.debug(
					{ src: "plugin:discord:voice", agentId: this.runtime.agentId },
					"Auto-reply disabled (DISCORD_AUTO_REPLY=false); voice message ingested without response",
				);
				return;
			}

			// Process voice message - try messageService first (newer core), fall back to events (older core)
			const messageService = getMessageService(this.runtime);
			if (messageService) {
				this.runtime.logger.debug(
					{ src: "plugin:discord:voice", agentId: this.runtime.agentId },
					"Using messageService API for voice",
				);
				await messageService.handleMessage(this.runtime, memory, callback);
			} else {
				this.runtime.logger.debug(
					{ src: "plugin:discord:voice", agentId: this.runtime.agentId },
					"Using event-based handling for voice",
				);
				const payload: EventPayload & {
					message: Memory;
					callback: HandlerCallback;
					accountId: string;
				} = {
					runtime: this.runtime,
					message: memory,
					callback,
					source: "discord",
					accountId: this.accountId,
				};
				await this.runtime.emitEvent(
					[EventType.VOICE_MESSAGE_RECEIVED],
					payload,
				);
			}
		} catch (error) {
			this.runtime.logger.error(
				{
					src: "plugin:discord:service:voice",
					agentId: this.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error processing voice message",
			);
		}
	}

	/**
	 * Asynchronously converts an Opus audio Buffer to a WAV audio Buffer.
	 *
	 * @param {Buffer} pcmBuffer - The Opus audio Buffer to convert to WAV.
	 * @returns {Promise<Buffer>} A Promise that resolves with the converted WAV audio Buffer.
	 */
	private async convertOpusToWav(pcmBuffer: Buffer): Promise<Buffer> {
		try {
			// Generate the WAV header
			const wavHeader = getWavHeader(pcmBuffer.length, DECODE_SAMPLE_RATE);

			// Concatenate the WAV header and PCM data
			const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);

			return wavBuffer;
		} catch (error) {
			this.runtime.logger.error(
				{
					src: "plugin:discord:service:voice",
					agentId: this.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error converting PCM to WAV",
			);
			throw error;
		}
	}

	/**
	 * Scans the given Discord guild to select a suitable voice channel to join.
	 *
	 * @param {Guild} guild The Discord guild to scan for voice channels.
	 */
	async scanGuild(guild: Guild) {
		let chosenChannel: BaseGuildVoiceChannel | null = null;

		try {
			const channelIds = String(
				this.runtime.getSetting("DISCORD_VOICE_CHANNEL_ID") ?? "",
			)
				.split(",")
				.map((channelId) => channelId.trim())
				.filter(Boolean);
			for (const channelId of channelIds) {
				const channel = await guild.channels.fetch(channelId).catch(() => null);
				if (
					channel?.isVoiceBased?.() &&
					channel.guild.id === guild.id &&
					!this.getVoiceConnection(guild.id) &&
					!this.isVoiceChannelClaimed?.(guild.id, channel.id)
				) {
					chosenChannel = channel as BaseGuildVoiceChannel;
					break;
				}
			}

			if (!chosenChannel) {
				const channels = (await guild.channels.fetch()).filter(
					(channel) =>
						channel && channel.type === DiscordChannelType.GuildVoice,
				);
				for (const [, channel] of channels) {
					const voiceChannel = channel as BaseGuildVoiceChannel;
					if (
						voiceChannel.members.size > 0 &&
						(chosenChannel === null ||
							voiceChannel.members.size > chosenChannel.members.size)
					) {
						chosenChannel = voiceChannel;
					}
				}
			}

			if (chosenChannel) {
				this.runtime.logger.debug(
					{
						src: "plugin:discord:service:voice",
						agentId: this.runtime.agentId,
						channelName: chosenChannel.name,
					},
					"Joining channel",
				);
				await this.joinChannel(chosenChannel);
			} else {
				this.runtime.logger.warn(
					{
						src: "plugin:discord:service:voice",
						agentId: this.runtime.agentId,
					},
					"No suitable voice channel found to join",
				);
			}
		} catch (error) {
			this.runtime.logger.error(
				{
					src: "plugin:discord:service:voice",
					agentId: this.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error selecting or joining a voice channel",
			);
		}
	}

	registerAudioLane(config: DiscordAudioLaneConfig): void {
		this.audioLanes.set(normalizeDiscordAudioLane(config.lane), {
			...config,
			lane: normalizeDiscordAudioLane(config.lane),
		});
	}

	getAudioLaneConfig(lane?: DiscordAudioLane | null): DiscordAudioLaneConfig {
		return getDiscordAudioLaneConfig(this.audioLanes, lane);
	}

	private getLanePlayerKey(
		guildId: string,
		lane?: DiscordAudioLane | null,
	): string {
		return `${guildId}:${normalizeDiscordAudioLane(lane)}`;
	}

	private stopLanePlayer(
		guildId: string,
		lane?: DiscordAudioLane | null,
		options?: { cancel?: boolean },
	): void {
		const normalizedLane = normalizeDiscordAudioLane(lane);
		const key = this.getLanePlayerKey(guildId, normalizedLane);
		const state = this.lanePlayers.get(key);
		if (!state) {
			return;
		}
		this.lanePlayers.delete(key);
		this.cleanupAudioPlayer(state.player);
		if (options?.cancel !== false && !state.abortController.signal.aborted) {
			state.abortController.abort();
			state.cancelled();
		}
		this.restoreDuckedLanes(guildId, normalizedLane);
	}

	private applyLanePriority(
		guildId: string,
		nextLane: DiscordAudioLane,
		mix: boolean,
	): void {
		const nextConfig = this.getAudioLaneConfig(nextLane);
		for (const state of this.lanePlayers.values()) {
			if (state.guildId !== guildId || state.lane === nextLane) {
				continue;
			}
			const activeConfig = this.getAudioLaneConfig(state.lane);
			if (
				nextConfig.priority <= activeConfig.priority ||
				!activeConfig.interruptible
			) {
				continue;
			}

			if (mix && activeConfig.duckVolume !== undefined && state.volume) {
				state.originalVolume = state.volume.volume ?? activeConfig.volume;
				state.duckedBy = nextLane;
				state.volume.setVolume(activeConfig.duckVolume);
				this.emit("audio:ducked", {
					guildId,
					lane: state.lane,
					by: nextLane,
				});
				continue;
			}

			this.stopLanePlayer(guildId, state.lane);
			this.emit("audio:interrupted", {
				guildId,
				lane: state.lane,
				by: nextLane,
			});
		}
	}

	private restoreDuckedLanes(
		guildId: string,
		finishedLane: DiscordAudioLane,
	): void {
		for (const state of this.lanePlayers.values()) {
			if (
				state.guildId !== guildId ||
				state.duckedBy !== finishedLane ||
				!state.volume ||
				state.originalVolume === undefined
			) {
				continue;
			}
			state.volume.setVolume(state.originalVolume);
			state.originalVolume = undefined;
			state.duckedBy = undefined;
			this.emit("audio:restored", { guildId, lane: state.lane });
		}
	}

	async playAudio(
		audioStream: Readable,
		options?: {
			guildId?: string;
			channelId?: string;
			lane?: DiscordAudioLane;
			interrupt?: boolean;
			mix?: boolean;
			signal?: AbortSignal;
		},
	): Promise<DiscordAudioPlaybackHandle> {
		const guildId = options?.guildId;
		if (!guildId) {
			throw new Error("Discord voice playback requires a guildId");
		}
		const connection = this.getVoiceConnection(guildId);
		if (!connection) {
			throw new Error(`No Discord voice connection for guild ${guildId}`);
		}

		const lane = normalizeDiscordAudioLane(options?.lane);
		const laneConfig = this.getAudioLaneConfig(lane);
		const key = this.getLanePlayerKey(guildId, lane);
		if (options?.interrupt !== false) {
			this.stopLanePlayer(guildId, lane);
		}
		this.applyLanePriority(guildId, lane, options?.mix ?? false);

		const {
			createAudioPlayer,
			createAudioResource,
			demuxProbe,
			NoSubscriberBehavior,
			StreamType,
		} = await loadDiscordVoiceModule();

		const abortController = new AbortController();
		const abortFromParent = () => abortController.abort();
		if (options?.signal) {
			if (options.signal.aborted) {
				abortController.abort();
			} else {
				options.signal.addEventListener("abort", abortFromParent, {
					once: true,
				});
			}
		}

		const audioPlayer = createAudioPlayer({
			behaviors: {
				noSubscriber: NoSubscriberBehavior.Pause,
			},
		});
		let resourceStream = audioStream;
		let inputType = StreamType.Arbitrary;
		try {
			const probe = await demuxProbe(audioStream);
			resourceStream = probe.stream;
			inputType = probe.type;
		} catch (error) {
			this.runtime.logger.debug(
				{
					src: "plugin:discord:service:voice",
					agentId: this.runtime.agentId,
					guildId,
					lane,
					error: error instanceof Error ? error.message : String(error),
				},
				"Discord audio stream probe failed; using arbitrary stream type",
			);
		}

		const resource = createAudioResource(resourceStream, {
			inputType,
			inlineVolume: true,
		});
		resource.volume?.setVolume(laneConfig.volume);

		const subscription = connection.subscribe(audioPlayer);
		if (!subscription) {
			throw new Error("Failed to subscribe Discord audio player");
		}

		let finishedResolver!: () => void;
		let cancelledResolver!: () => void;
		const finished = new Promise<void>((resolve) => {
			finishedResolver = resolve;
		});
		const cancelled = new Promise<void>((resolve) => {
			cancelledResolver = resolve;
		});

		const state: LanePlayerState = {
			player: audioPlayer,
			lane,
			guildId,
			channelId: options?.channelId ?? connection.joinConfig.channelId ?? "",
			finished: finishedResolver,
			cancelled: cancelledResolver,
			abortController,
			volume: resource.volume,
		};
		this.lanePlayers.set(key, state);

		const cleanupParentAbort = () => {
			options?.signal?.removeEventListener("abort", abortFromParent);
		};
		abortController.signal.addEventListener(
			"abort",
			() => {
				this.stopLanePlayer(guildId, lane, { cancel: false });
				cleanupParentAbort();
				cancelledResolver();
			},
			{ once: true },
		);

		audioPlayer.on("error", (error: Error) => {
			this.runtime.logger.error(
				{
					src: "plugin:discord:service:voice",
					agentId: this.runtime.agentId,
					guildId,
					lane,
					error: error instanceof Error ? error.message : String(error),
				},
				"Discord audio lane playback error",
			);
			this.stopLanePlayer(guildId, lane, { cancel: false });
			cleanupParentAbort();
			cancelledResolver();
			this.emit("audio:error", { guildId, lane, error });
		});
		audioPlayer.on(
			"stateChange",
			(_oldState: unknown, newState: { status: string }) => {
				if (newState.status !== "idle") {
					return;
				}
				this.stopLanePlayer(guildId, lane, { cancel: false });
				cleanupParentAbort();
				finishedResolver();
				this.emit("audio:finished", { guildId, lane });
			},
		);

		audioPlayer.play(resource);
		this.emit("audio:started", { guildId, lane });

		return {
			finished,
			cancelled,
			abort: () => abortController.abort(),
		};
	}

	async stopAudio(guildId: string, lane?: DiscordAudioLane): Promise<void> {
		if (lane) {
			this.stopLanePlayer(guildId, lane);
			this.emit("audio:stopped", { guildId, lane });
			return;
		}

		for (const state of [...this.lanePlayers.values()]) {
			if (state.guildId === guildId) {
				this.stopLanePlayer(guildId, state.lane);
				this.emit("audio:stopped", { guildId, lane: state.lane });
			}
		}
	}

	/**
	 * Play an audio stream for a given entity ID.
	 *
	 * @param {UUID} entityId - The ID of the entity to play the audio for.
	 * @param {Readable} audioStream - The audio stream to play.
	 * @returns {void}
	 */
	async playAudioStream(entityId: UUID, audioStream: Readable) {
		const connection = this.connections.get(entityId);
		if (connection == null) {
			this.runtime.logger.debug(
				{
					src: "plugin:discord:service:voice",
					agentId: this.runtime.agentId,
					entityId,
				},
				"No connection for user",
			);
			return;
		}
		this.cleanupAudioPlayer(this.activeAudioPlayer);
		const {
			createAudioPlayer,
			createAudioResource,
			NoSubscriberBehavior,
			StreamType,
		} = await loadDiscordVoiceModule();
		const audioPlayer = createAudioPlayer({
			behaviors: {
				noSubscriber: NoSubscriberBehavior.Pause,
			},
		});
		this.activeAudioPlayer = audioPlayer;
		connection.subscribe(audioPlayer);

		const audioStartTime = Date.now();

		const resource = createAudioResource(audioStream, {
			inputType: StreamType.Arbitrary,
		});
		audioPlayer.play(resource);

		audioPlayer.on("error", (err: Error) => {
			this.runtime.logger.error(
				{
					src: "plugin:discord:service:voice",
					agentId: this.runtime.agentId,
					error: err instanceof Error ? err.message : String(err),
				},
				"Audio player error",
			);
		});

		audioPlayer.on(
			"stateChange",
			(_oldState: unknown, newState: { status: string }) => {
				if (newState.status === "idle") {
					const idleTime = Date.now();
					this.runtime.logger.debug(
						{
							src: "plugin:discord:service:voice",
							agentId: this.runtime.agentId,
							durationMs: idleTime - audioStartTime,
						},
						"Audio playback completed",
					);
				}
			},
		);
	}

	/**
	 * Cleans up the provided audio player by stopping it, removing all listeners,
	 * and resetting the active audio player if it matches the provided player.
	 *
	 * @param {AudioPlayer} audioPlayer - The audio player to be cleaned up.
	 */
	cleanupAudioPlayer(audioPlayer: AudioPlayer | null) {
		if (!audioPlayer) {
			return;
		}

		audioPlayer.stop();
		audioPlayer.removeAllListeners();
		if (audioPlayer === this.activeAudioPlayer) {
			this.activeAudioPlayer = null;
		}
	}

	/**
	 * Asynchronously handles the join channel command in an interaction.
	 *
	 * @param interaction - The interaction object representing the user's input.
	 * @returns A promise that resolves once the join channel command is handled.
	 */
	async handleJoinChannelCommand(interaction: {
		deferReply: () => Promise<void>;
		options: {
			get: (name: string) => { value: string } | null;
		};
		guild: Guild | null;
		editReply: (message: string) => Promise<void>;
	}) {
		try {
			// Defer the reply immediately to prevent interaction timeout
			await interaction.deferReply();

			const interactionOptionsChannel = interaction.options.get("channel");
			const channelId = interactionOptionsChannel?.value as string;
			if (!channelId) {
				await interaction.editReply("Please provide a voice channel to join.");
				return;
			}

			const guild = interaction.guild;
			if (!guild) {
				await interaction.editReply("Could not find guild.");
				return;
			}

			const voiceChannel = guild.channels.cache.find(
				(channel) =>
					channel.id === channelId &&
					channel.type === DiscordChannelType.GuildVoice,
			);

			if (!voiceChannel) {
				await interaction.editReply("Voice channel not found!");
				return;
			}

			await this.joinChannel(voiceChannel as BaseGuildVoiceChannel);
			await interaction.editReply(`Joined voice channel: ${voiceChannel.name}`);
		} catch (error) {
			this.runtime.logger.error(
				{
					src: "plugin:discord:service:voice",
					agentId: this.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error joining voice channel",
			);
			// Use editReply instead of reply for the error case
			await interaction
				.editReply("Failed to join the voice channel.")
				.catch((err: Error) => {
					this.runtime.logger.error(
						{
							src: "plugin:discord:service:voice",
							agentId: this.runtime.agentId,
							error: err.message,
						},
						"Failed to send error reply",
					);
				});
		}
	}

	/**
	 * Handles the leave channel command by destroying the voice connection if it exists.
	 *
	 * @param interaction - The interaction object representing the command invocation.
	 * @returns A promise that resolves once the leave channel command is handled.
	 */
	async handleLeaveChannelCommand(interaction: {
		guildId: string | null;
		reply: (message: string) => Promise<void>;
	}) {
		if (!interaction.guildId) {
			await interaction.reply("This command can only be used in a server.");
			return;
		}
		const connection = this.getVoiceConnection(interaction.guildId);

		if (!connection) {
			await interaction.reply("Not currently in a voice channel.");
			return;
		}

		try {
			const channelId = connection.joinConfig.channelId;
			if (channelId) {
				await this.stopVoiceTranscription(channelId, "requested_stop");
			}
			connection.destroy();
			await interaction.reply("Left the voice channel.");
		} catch (error) {
			this.runtime.logger.error(
				{
					src: "plugin:discord:service:voice",
					agentId: this.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error leaving voice channel",
			);
			await interaction.reply("Failed to leave the voice channel.");
		}
	}
}
