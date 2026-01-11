import { EventEmitter } from "node:events";
import { pipeline, Readable } from "node:stream";
import {
  type AudioPlayer,
  type AudioReceiveStream,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnections,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  type VoiceConnection,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import {
  ChannelType,
  type Content,
  createUniqueUuid,
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
  type VoiceChannel,
  type VoiceState,
} from "discord.js";
import prism from "prism-media";
// See service.ts for detailed documentation on Discord ID handling.
// Key point: Discord snowflake IDs (e.g., "1253563208833433701") are NOT valid UUIDs.
// Use stringToUuid() to convert them, not asUUID() which would throw an error.
import type { ICompatRuntime } from "./compat";
import type { DiscordService } from "./service";
import { getMessageService } from "./utils";

// These values are chosen for compatibility with picovoice components
const DECODE_FRAME_SIZE = 1024;
const DECODE_SAMPLE_RATE = 16000;

/**
 * Creates an opus decoder with fallback handling for different opus libraries
 * @param options - Decoder options including channels, rate, and frameSize
 * @returns An opus decoder instance or null if creation fails
 */
function createOpusDecoder(options: {
  channels: number;
  rate: number;
  frameSize: number;
}): NodeJS.ReadWriteStream {
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
      "Failed to create opus decoder"
    );

    // Log available opus libraries for debugging
    try {
      const { generateDependencyReport } = require("@discordjs/voice");
      const report = generateDependencyReport();
      logger.debug({ src: "plugin:discord:service:voice", report }, "Voice dependency report");
    } catch (reportError) {
      logger.warn(
        {
          src: "plugin:discord:service:voice",
          error: reportError instanceof Error ? reportError.message : String(reportError),
        },
        "Could not generate dependency report"
      );
    }

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
  bitsPerSample = 16
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
    callback: (buffer: Buffer) => void
  ) {
    this.readable = readable;
    this.maxSize = maxSize;
    this.readable.on("data", (chunk: Buffer) => {
      if (this.lastFlagged < 0) {
        this.lastFlagged = this.buffers.length;
      }
      this.buffers.push(chunk);
      const currentSize = this.buffers.reduce((acc, cur) => acc + cur.length, 0);
      while (currentSize > this.maxSize) {
        this.buffers.shift();
        this.lastFlagged--;
      }
    });
    this.readable.on("end", () => {
      logger.debug({ src: "plugin:discord:service:voice" }, "AudioMonitor ended");
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
  private streams: Map<string, Readable> = new Map();
  private connections: Map<string, VoiceConnection> = new Map();
  private activeMonitors: Map<string, { channel: BaseGuildVoiceChannel; monitor: AudioMonitor }> =
    new Map();
  private ready: boolean;

  /**
   * Constructor for initializing a new instance of the class.
   *
   * @param {DiscordService} service - The Discord service to use.
   * @param {ICompatRuntime} runtime - The runtime for the agent (with cross-core compat).
   */
  constructor(service: DiscordService, runtime: ICompatRuntime) {
    super();
    this.client = service.client;
    this.runtime = runtime;
    this.ready = false;

    if (this.client) {
      this.client.on("voiceManagerReady", () => {
        this.setReady(true);
      });
    } else {
      this.runtime.logger.error(
        { src: "plugin:discord:service:voice", agentId: this.runtime.agentId },
        "Discord client not available for voiceManagerReady event"
      );
      this.ready = false;
    }
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
          "Unexpected channel type"
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
      "VoiceManager ready status changed"
    );
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
    }

    // User joining a channel where the bot is present
    if (newChannelId && this.connections.has(newChannelId)) {
      await this.monitorMember(member, newState.channel as BaseGuildVoiceChannel);
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
        oldConnection.destroy();
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
          "Error leaving voice channel"
        );
      }
    }

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
        "Voice connection established"
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
          "Voice connection state changed"
        );

        if (newState.status === VoiceConnectionStatus.Disconnected) {
          this.runtime.logger.debug(
            {
              src: "plugin:discord:service:voice",
              agentId: this.runtime.agentId,
            },
            "Handling disconnection"
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
              "Reconnecting to channel"
            );
          } catch (e) {
            // Seems to be a real disconnect, destroy and cleanup
            this.runtime.logger.debug(
              {
                src: "plugin:discord:service:voice",
                agentId: this.runtime.agentId,
                error: e instanceof Error ? e.message : String(e),
              },
              "Disconnection confirmed - cleaning up"
            );
            connection.destroy();
            this.connections.delete(channel.id);
          }
        } else if (newState.status === VoiceConnectionStatus.Destroyed) {
          this.connections.delete(channel.id);
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
          "Voice connection error"
        );
        // Don't immediately destroy - let the state change handler deal with it
        this.runtime.logger.debug(
          {
            src: "plugin:discord:service:voice",
            agentId: this.runtime.agentId,
          },
          "Will attempt to recover"
        );
      });

      // Store the connection
      this.connections.set(channel.id, connection);

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
            "Failed to modify voice state"
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
              "Failed to fetch user"
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
        "Failed to establish voice connection"
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
    const clientUser = this.client?.user;
    const userId = clientUser?.id;
    if (!userId) {
      this.runtime.logger.error(
        { src: "plugin:discord:service:voice", agentId: this.runtime.agentId },
        "Client user ID not available"
      );
      return undefined;
    }
    const connections = getVoiceConnections(userId);
    if (!connections) {
      return;
    }
    const connection = [...connections.values()].find(
      (connection) => connection.joinConfig.guildId === guildId
    );
    return connection;
  }

  /**
   * Monitor a member's audio stream for volume activity and speaking thresholds.
   *
   * @param {GuildMember} member - The member whose audio stream is being monitored.
   * @param {BaseGuildVoiceChannel} channel - The voice channel in which the member is connected.
   */
  private async monitorMember(member: GuildMember, channel: BaseGuildVoiceChannel) {
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
        "No receiveStream or empty stream"
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
        "Failed to create opus decoder"
      );
      // For now, log the error and return early.
      // In production, you might want to implement a PCM fallback or other audio processing
      return;
    }

    const volumeBuffer: number[] = [];
    const VOLUME_WINDOW_SIZE = 30;
    const SPEAKING_THRESHOLD = 0.05;
    opusDecoder.on("data", (pcmData: Buffer) => {
      // Monitor the audio volume while the agent is speaking.
      // If the average volume of the user's audio exceeds the defined threshold, it indicates active speaking.
      // When active speaking is detected, stop the agent's current audio playbook to avoid overlap.

      if (this.activeAudioPlayer) {
        const samples = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.length / 2);
        const maxAmplitude = Math.max(...samples.map(Math.abs)) / 32768;
        volumeBuffer.push(maxAmplitude);

        if (volumeBuffer.length > VOLUME_WINDOW_SIZE) {
          volumeBuffer.shift();
        }
        const avgVolume = volumeBuffer.reduce((sum, v) => sum + v, 0) / VOLUME_WINDOW_SIZE;

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
        "Opus decoder not available"
      );
      return;
    }
    pipeline(receiveStream as AudioReceiveStream, opusDecoder, (err: Error | null) => {
      if (err) {
        this.runtime.logger.debug(
          {
            src: "plugin:discord:service:voice",
            agentId: this.runtime.agentId,
            entityId,
            error: err.message,
          },
          "Opus decoding pipeline error"
        );
      } else {
        this.runtime.logger.debug(
          {
            src: "plugin:discord:service:voice",
            agentId: this.runtime.agentId,
            entityId,
          },
          "Opus decoding pipeline finished"
        );
      }
    });
    // NodeJS.ReadWriteStream extends Readable, but TypeScript can't verify this statically
    // @ts-expect-error - ReadWriteStream implements Readable interface at runtime
    this.streams.set(entityId, opusDecoder as Readable);
    this.connections.set(entityId, connection as VoiceConnection);
    opusDecoder.on("error", (err: Error) => {
      this.runtime.logger.debug(
        {
          src: "plugin:discord:service:voice",
          agentId: this.runtime.agentId,
          error: err instanceof Error ? err.message : String(err),
        },
        "Opus decoding error"
      );
    });
    const errorHandler = (err: Error) => {
      this.runtime.logger.debug(
        {
          src: "plugin:discord:service:voice",
          agentId: this.runtime.agentId,
          error: err instanceof Error ? err.message : String(err),
        },
        "Opus decoding error"
      );
    };
    const streamCloseHandler = () => {
      this.runtime.logger.debug(
        {
          src: "plugin:discord:service:voice",
          agentId: this.runtime.agentId,
          member: member?.displayName || undefined,
        },
        "Voice stream closed"
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
        "Opus decoder closed"
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
      this.client.emit("userStream", entityId, name, userName, channel, opusDecoder);
    }
  }

  /**
   * Leaves the specified voice channel and stops monitoring all members in that channel.
   * If there is an active connection in the channel, it will be destroyed.
   *
   * @param {BaseGuildVoiceChannel} channel - The voice channel to leave.
   */
  leaveChannel(channel: BaseGuildVoiceChannel) {
    const connection = this.connections.get(channel.id);
    if (connection) {
      connection.destroy();
      this.connections.delete(channel.id);
    }

    // Stop monitoring all members in this channel
    for (const [memberId, monitorInfo] of this.activeMonitors) {
      if (monitorInfo.channel.id === channel.id && memberId !== this.client?.user?.id) {
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
      "Left voice channel"
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
        "Stopped monitoring user"
      );
    }
  }

  /**
   * Asynchronously debounces the process transcription function to prevent rapid execution.
   *
   * @param {UUID} entityId - The ID of the entity related to the transcription.
   * @param {string} name - The name of the entity for transcription.
   * @param {string} userName - The username of the user initiating the transcription.
   * @param {BaseGuildVoiceChannel} channel - The voice channel where the transcription is happening.
   */

  async debouncedProcessTranscription(
    entityId: UUID,
    name: string,
    userName: string,
    channel: BaseGuildVoiceChannel
  ) {
    const DEBOUNCE_TRANSCRIPTION_THRESHOLD = 1500; // wait for 1.5 seconds of silence

    const activeAudioPlayer = this.activeAudioPlayer;
    const activeAudioPlayerState = activeAudioPlayer?.state;
    if (activeAudioPlayerState && activeAudioPlayerState.status === "idle") {
      this.runtime.logger.debug(
        { src: "plugin:discord:service:voice", agentId: this.runtime.agentId },
        "Cleaning up idle audio player"
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
        await this.processTranscription(entityId, channel.id, channel, name, userName);

        // Clean all users' previous buffers
        this.userStates.forEach((state, _) => {
          state.buffers.length = 0;
          state.totalLength = 0;
        });
      } finally {
        this.processingVoice = false;
      }
    }, DEBOUNCE_TRANSCRIPTION_THRESHOLD);
  }

  /**
   * Handle user audio stream for monitoring purposes.
   *
   * @param {UUID} userId - The unique identifier of the user.
   * @param {string} name - The name of the user.
   * @param {string} userName - The username of the user.
   * @param {BaseGuildVoiceChannel} channel - The voice channel the user is in.
   * @param {Readable} audioStream - The audio stream to monitor.
   */
  async handleUserStream(
    entityId: UUID,
    name: string,
    userName: string,
    channel: BaseGuildVoiceChannel,
    audioStream: Readable
  ) {
    this.runtime.logger.debug(
      {
        src: "plugin:discord:service:voice",
        agentId: this.runtime.agentId,
        entityId,
      },
      "Starting audio monitor"
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
          "Error processing buffer"
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
            "Received empty buffer"
          );
          return;
        }
        await processBuffer(buffer);
      }
    );
  }

  /**
   * Process the transcription of audio data for a user.
   *
   * @param {UUID} entityId - The unique ID of the user entity.
   * @param {string} channelId - The ID of the channel where the transcription is taking place.
   * @param {BaseGuildVoiceChannel} channel - The voice channel where the user is speaking.
   * @param {string} name - The name of the user.
   * @param {string} userName - The username of the user.
   * @returns {Promise<void>}
   */
  private async processTranscription(
    entityId: UUID,
    channelId: string,
    channel: BaseGuildVoiceChannel,
    name: string,
    userName: string
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
        "Starting transcription"
      );

      const transcriptionText = await this.runtime.useModel(ModelType.TRANSCRIPTION, wavBuffer);
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
        await this.handleMessage(finalText, entityId, channelId, channel, name, userName);
      }
    } catch (error) {
      this.runtime.logger.error(
        {
          src: "plugin:discord:service:voice",
          agentId: this.runtime.agentId,
          entityId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error transcribing audio"
      );
    }
  }

  /**
   * Handles a voice message received in a Discord channel.
   *
   * @param {string} message - The message content.
   * @param {UUID} entityId - The entity ID associated with the message.
   * @param {string} channelId - The ID of the Discord channel where the message was received.
   * @param {BaseGuildVoiceChannel} channel - The Discord channel where the message was received.
   * @param {string} name - The name associated with the message.
   * @param {string} userName - The user name associated with the message.
   * @returns {Promise<{text: string, actions: string[]}>} Object containing the resulting text and actions.
   */
  private async handleMessage(
    message: string,
    entityId: UUID,
    channelId: string,
    channel: BaseGuildVoiceChannel,
    name: string,
    userName: string
  ) {
    try {
      if (!message || message.trim() === "" || message.length < 3) {
        return { text: "", actions: ["IGNORE"] };
      }

      const roomId = createUniqueUuid(this.runtime, channelId);
      const uniqueEntityId = createUniqueUuid(this.runtime, entityId);
      const type = await this.getChannelType(channel as Channel);

      await this.runtime.ensureConnection({
        entityId: uniqueEntityId,
        roomId,
        userName,
        name,
        source: "discord",
        channelId,
        // Convert Discord snowflake to UUID (see service.ts header for why stringToUuid not asUUID)
        messageServerId: stringToUuid(channel.guild.id),
        type,
        worldId: createUniqueUuid(this.runtime, channel.guild.id) as UUID,
        worldName: channel.guild.name,
      });

      const memory: Memory = {
        id: createUniqueUuid(this.runtime, `${channelId}-voice-message-${Date.now()}`),
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
        createdAt: Date.now(),
      };

      const callback: HandlerCallback = async (content: Content, _actionName?: string) => {
        try {
          const responseMemory: Memory = {
            id: createUniqueUuid(this.runtime, `${memory.id}-voice-response-${Date.now()}`),
            entityId: this.runtime.agentId,
            agentId: this.runtime.agentId,
            content: {
              ...content,
              name: this.runtime.character.name,
              inReplyTo: memory.id,
              isVoiceMessage: true,
              channelType: type,
            },
            roomId,
            createdAt: Date.now(),
          };

          const responseMemoryContentText = responseMemory.content.text;
          if (responseMemoryContentText?.trim()) {
            await this.runtime.createMemory(responseMemory, "messages");

            if (content.text) {
              const responseStream = await this.runtime.useModel(
                ModelType.TEXT_TO_SPEECH,
                content.text
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
            "Error in voice message callback"
          );
          return [];
        }
      };

      // Process voice message - try messageService first (newer core), fall back to events (older core)
      const messageService = getMessageService(this.runtime);
      if (messageService) {
        this.runtime.logger.debug(
          { src: "plugin:discord:voice", agentId: this.runtime.agentId },
          "Using messageService API for voice"
        );
        await messageService.handleMessage(this.runtime, memory, callback);
      } else {
        this.runtime.logger.debug(
          { src: "plugin:discord:voice", agentId: this.runtime.agentId },
          "Using event-based handling for voice"
        );
        await this.runtime.emitEvent([EventType.VOICE_MESSAGE_RECEIVED], {
          runtime: this.runtime,
          message: memory,
          callback,
          source: "discord",
        });
      }
    } catch (error) {
      this.runtime.logger.error(
        {
          src: "plugin:discord:service:voice",
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error processing voice message"
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
        "Error converting PCM to WAV"
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
      const channelId = this.runtime.getSetting("DISCORD_VOICE_CHANNEL_ID") as string;
      if (channelId) {
        const channel = await guild.channels.fetch(channelId);
        if (channel?.isVoiceBased?.()) {
          chosenChannel = channel as BaseGuildVoiceChannel;
        }
      }

      if (!chosenChannel) {
        const channels = (await guild.channels.fetch()).filter(
          (channel) => channel && channel.type === DiscordChannelType.GuildVoice
        );
        for (const [, channel] of channels) {
          const voiceChannel = channel as BaseGuildVoiceChannel;
          if (
            voiceChannel.members.size > 0 &&
            (chosenChannel === null || voiceChannel.members.size > chosenChannel.members.size)
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
          "Joining channel"
        );
        await this.joinChannel(chosenChannel);
      } else {
        this.runtime.logger.warn(
          {
            src: "plugin:discord:service:voice",
            agentId: this.runtime.agentId,
          },
          "No suitable voice channel found to join"
        );
      }
    } catch (error) {
      this.runtime.logger.error(
        {
          src: "plugin:discord:service:voice",
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error selecting or joining a voice channel"
      );
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
        "No connection for user"
      );
      return;
    }
    this.cleanupAudioPlayer(this.activeAudioPlayer);
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
        "Audio player error"
      );
    });

    audioPlayer.on("stateChange", (_oldState: unknown, newState: { status: string }) => {
      if (newState.status === "idle") {
        const idleTime = Date.now();
        this.runtime.logger.debug(
          {
            src: "plugin:discord:service:voice",
            agentId: this.runtime.agentId,
            durationMs: idleTime - audioStartTime,
          },
          "Audio playback completed"
        );
      }
    });
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

      const voiceChannel = interaction.guild.channels.cache.find(
        (channel: VoiceChannel) =>
          channel.id === channelId && channel.type === DiscordChannelType.GuildVoice
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
        "Error joining voice channel"
      );
      // Use editReply instead of reply for the error case
      await interaction.editReply("Failed to join the voice channel.").catch((err: Error) => {
        this.runtime.logger.error(
          {
            src: "plugin:discord:service:voice",
            agentId: this.runtime.agentId,
            error: err.message,
          },
          "Failed to send error reply"
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
      connection.destroy();
      await interaction.reply("Left the voice channel.");
    } catch (error) {
      this.runtime.logger.error(
        {
          src: "plugin:discord:service:voice",
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error leaving voice channel"
      );
      await interaction.reply("Failed to leave the voice channel.");
    }
  }
}
