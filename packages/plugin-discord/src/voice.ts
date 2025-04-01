import { EventEmitter } from 'node:events';
import { type Readable, pipeline } from 'node:stream';
import {
  type AudioPlayer,
  type AudioReceiveStream,
  NoSubscriberBehavior,
  StreamType,
  type VoiceConnection,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnections,
  joinVoiceChannel,
} from '@discordjs/voice';
import {
  ChannelType,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type UUID,
  createUniqueUuid,
  getWavHeader,
  logger,
} from '@elizaos/core';
import {
  type BaseGuildVoiceChannel,
  type Channel,
  type Client,
  ChannelType as DiscordChannelType,
  type Guild,
  type GuildMember,
  type VoiceChannel,
  type VoiceState,
} from 'discord.js';
import prism from 'prism-media';
import type { DiscordService } from './service';

// These values are chosen for compatibility with picovoice components
const DECODE_FRAME_SIZE = 1024;
const DECODE_SAMPLE_RATE = 16000;

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
    this.readable.on('data', (chunk: Buffer) => {
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
    this.readable.on('end', () => {
      logger.log('AudioMonitor ended');
      this.ended = true;
      if (this.lastFlagged < 0) return;
      callback(this.getBufferFromStart());
      this.lastFlagged = -1;
    });
    this.readable.on('speakingStopped', () => {
      if (this.ended) return;
      logger.log('Speaking stopped');
      if (this.lastFlagged < 0) return;
      callback(this.getBufferFromStart());
    });
    this.readable.on('speakingStarted', () => {
      if (this.ended) return;
      onStart();
      logger.log('Speaking started');
      this.reset();
    });
  }

  /**
   * Stops listening to "data", "end", "speakingStopped", and "speakingStarted" events on the readable stream.
   */
  stop() {
    this.readable.removeAllListeners('data');
    this.readable.removeAllListeners('end');
    this.readable.removeAllListeners('speakingStopped');
    this.readable.removeAllListeners('speakingStarted');
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
  private transcriptionTimeout: NodeJS.Timeout | null = null;
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
  private client: Client;
  private runtime: IAgentRuntime;
  private streams: Map<string, Readable> = new Map();
  private connections: Map<string, VoiceConnection> = new Map();
  private activeMonitors: Map<string, { channel: BaseGuildVoiceChannel; monitor: AudioMonitor }> =
    new Map();
  private ready: boolean;

  /**
   * Constructor for initializing a new instance of the class.
   *
   * @param {DiscordService} service - The Discord service to use.
   * @param {IAgentRuntime} runtime - The runtime for the agent.
   */
  constructor(service: DiscordService, runtime: IAgentRuntime) {
    super();
    this.client = service.client;
    this.runtime = runtime;

    this.client.on('voiceManagerReady', () => {
      this.setReady(true);
    });
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
    }
  }

  /**
   * Set the ready status of the VoiceManager.
   * @param {boolean} status - The status to set.
   */
  private setReady(status: boolean) {
    this.ready = status;
    this.emit('ready');
    logger.debug(`VoiceManager is now ready: ${this.ready}`);
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
    if (!member) return;
    if (member.id === this.client.user?.id) {
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
        console.error('Error leaving voice channel:', error);
      }
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator as any,
      selfDeaf: false,
      selfMute: false,
      group: this.client.user.id,
    });

    try {
      // Wait for either Ready or Signalling state
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Ready, 20_000),
        entersState(connection, VoiceConnectionStatus.Signalling, 20_000),
      ]);

      // Log connection success
      logger.log(`Voice connection established in state: ${connection.state.status}`);

      // Set up ongoing state change monitoring
      connection.on('stateChange', async (oldState, newState) => {
        logger.log(`Voice connection state changed from ${oldState.status} to ${newState.status}`);

        if (newState.status === VoiceConnectionStatus.Disconnected) {
          logger.log('Handling disconnection...');

          try {
            // Try to reconnect if disconnected
            await Promise.race([
              entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
              entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ]);
            // Seems to be reconnecting to a new channel
            logger.log('Reconnecting to channel...');
          } catch (e) {
            // Seems to be a real disconnect, destroy and cleanup
            logger.log(`Disconnection confirmed - cleaning up...${e}`);
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

      connection.on('error', (error) => {
        logger.log('Voice connection error:', error);
        // Don't immediately destroy - let the state change handler deal with it
        logger.log('Connection error - will attempt to recover...');
      });

      // Store the connection
      this.connections.set(channel.id, connection);

      // Continue with voice state modifications
      const me = channel.guild.members.me;
      if (me?.voice && me.permissions.has('DeafenMembers')) {
        try {
          await me.voice.setDeaf(false);
          await me.voice.setMute(false);
        } catch (error) {
          logger.log('Failed to modify voice state:', error);
          // Continue even if this fails
        }
      }

      connection.receiver.speaking.on('start', async (entityId: string) => {
        let user = channel.members.get(entityId);
        if (!user) {
          try {
            user = await channel.guild.members.fetch(entityId);
          } catch (error) {
            console.error('Failed to fetch user:', error);
          }
        }
        if (user && !user?.user.bot) {
          this.monitorMember(user as GuildMember, channel);
          this.streams.get(entityId)?.emit('speakingStarted');
        }
      });

      connection.receiver.speaking.on('end', async (entityId: string) => {
        const user = channel.members.get(entityId);
        if (!user?.user.bot) {
          this.streams.get(entityId)?.emit('speakingStopped');
        }
      });
    } catch (error) {
      logger.log('Failed to establish voice connection:', error);
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
    const connections = getVoiceConnections(this.client.user.id);
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
    const userName = member?.user?.username;
    const name = member?.user?.displayName;
    const connection = this.getVoiceConnection(member?.guild?.id);
    const receiveStream = connection?.receiver.subscribe(entityId, {
      autoDestroy: true,
      emitClose: true,
    });
    if (!receiveStream || receiveStream.readableLength === 0) {
      return;
    }
    const opusDecoder = new prism.opus.Decoder({
      channels: 1,
      rate: DECODE_SAMPLE_RATE,
      frameSize: DECODE_FRAME_SIZE,
    });
    const volumeBuffer: number[] = [];
    const VOLUME_WINDOW_SIZE = 30;
    const SPEAKING_THRESHOLD = 0.05;
    opusDecoder.on('data', (pcmData: Buffer) => {
      // Monitor the audio volume while the agent is speaking.
      // If the average volume of the user's audio exceeds the defined threshold, it indicates active speaking.
      // When active speaking is detected, stop the agent's current audio playback to avoid overlap.

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
    pipeline(receiveStream as AudioReceiveStream, opusDecoder as any, (err: Error | null) => {
      if (err) {
        logger.debug(`Opus decoding pipeline error: ${err}`);
      }
    });
    this.streams.set(entityId, opusDecoder);
    this.connections.set(entityId, connection as VoiceConnection);
    opusDecoder.on('error', (err: any) => {
      logger.debug(`Opus decoding error: ${err}`);
    });
    const errorHandler = (err: any) => {
      logger.debug(`Opus decoding error: ${err}`);
    };
    const streamCloseHandler = () => {
      logger.debug(`voice stream from ${member?.displayName} closed`);
      this.streams.delete(entityId);
      this.connections.delete(entityId);
    };
    const closeHandler = () => {
      logger.debug(`Opus decoder for ${member?.displayName} closed`);
      opusDecoder.removeListener('error', errorHandler);
      opusDecoder.removeListener('close', closeHandler);
      receiveStream?.removeListener('close', streamCloseHandler);
    };
    opusDecoder.on('error', errorHandler);
    opusDecoder.on('close', closeHandler);
    receiveStream?.on('close', streamCloseHandler);

    this.client.emit('userStream', entityId, name, userName, channel, opusDecoder);
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
      if (monitorInfo.channel.id === channel.id && memberId !== this.client.user?.id) {
        this.stopMonitoringMember(memberId);
      }
    }

    logger.debug(`Left voice channel: ${channel.name} (${channel.id})`);
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
      logger.debug(`Stopped monitoring user ${memberId}`);
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

    if (this.activeAudioPlayer?.state?.status === 'idle') {
      logger.log('Cleaning up idle audio player.');
      this.cleanupAudioPlayer(this.activeAudioPlayer);
    }

    if (this.activeAudioPlayer || this.processingVoice) {
      const state = this.userStates.get(entityId);
      state.buffers.length = 0;
      state.totalLength = 0;
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
    }, DEBOUNCE_TRANSCRIPTION_THRESHOLD) as unknown as NodeJS.Timeout;
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
    logger.debug(`Starting audio monitor for user: ${entityId}`);
    if (!this.userStates.has(entityId)) {
      this.userStates.set(entityId, {
        buffers: [],
        totalLength: 0,
        lastActive: Date.now(),
        transcriptionText: '',
      });
    }

    const state = this.userStates.get(entityId);

    const processBuffer = async (buffer: Buffer) => {
      try {
        state?.buffers.push(buffer);
        state!.totalLength += buffer.length;
        state!.lastActive = Date.now();
        this.debouncedProcessTranscription(entityId, name, userName, channel);
      } catch (error) {
        console.error(`Error processing buffer for user ${entityId}:`, error);
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
          console.error('Received empty buffer');
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
    if (!state || state.buffers.length === 0) return;
    try {
      const inputBuffer = Buffer.concat(state.buffers, state.totalLength);

      state.buffers.length = 0; // Clear the buffers
      state.totalLength = 0;
      // Convert Opus to WAV
      const wavBuffer = await this.convertOpusToWav(inputBuffer);
      logger.debug('Starting transcription...');

      const transcriptionText = await this.runtime.useModel(ModelType.TRANSCRIPTION, wavBuffer);
      function isValidTranscription(text: string): boolean {
        if (!text || text.includes('[BLANK_AUDIO]')) return false;
        return true;
      }

      if (transcriptionText && isValidTranscription(transcriptionText)) {
        state.transcriptionText += transcriptionText;
      }

      if (state.transcriptionText.length) {
        this.cleanupAudioPlayer(this.activeAudioPlayer);
        const finalText = state.transcriptionText;
        state.transcriptionText = '';
        await this.handleMessage(finalText, entityId, channelId, channel, name, userName);
      }
    } catch (error) {
      console.error(`Error transcribing audio for user ${entityId}:`, error);
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
      if (!message || message.trim() === '' || message.length < 3) {
        return { text: '', actions: ['IGNORE'] };
      }

      const roomId = createUniqueUuid(this.runtime, channelId);
      const uniqueEntityId = createUniqueUuid(this.runtime, entityId);
      const type = await this.getChannelType(channel as Channel);

      await this.runtime.ensureConnection({
        entityId: uniqueEntityId,
        roomId,
        userName,
        name: name,
        source: 'discord',
        channelId,
        serverId: channel.guild.id,
        type,
      });

      const memory: Memory = {
        id: createUniqueUuid(this.runtime, `${channelId}-voice-message-${Date.now()}`),
        agentId: this.runtime.agentId,
        entityId: uniqueEntityId,
        roomId,
        content: {
          text: message,
          source: 'discord',
          url: channel.url,
          name: name,
          userName: userName,
          isVoiceMessage: true,
          channelType: type,
        },
        createdAt: Date.now(),
      };

      const callback: HandlerCallback = async (content: Content, _files: any[] = []) => {
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

          if (responseMemory.content.text?.trim()) {
            await this.runtime.createMemory(responseMemory, 'messages');

            const responseStream = await this.runtime.useModel(
              ModelType.TEXT_TO_SPEECH,
              content.text
            );
            if (responseStream) {
              await this.playAudioStream(entityId, responseStream as Readable);
            }
          }

          return [responseMemory];
        } catch (error) {
          console.error('Error in voice message callback:', error);
          return [];
        }
      };

      // Emit voice-specific events
      this.runtime.emitEvent(['DISCORD_VOICE_MESSAGE_RECEIVED', 'VOICE_MESSAGE_RECEIVED'], {
        runtime: this.runtime,
        message: memory,
        callback,
      });
    } catch (error) {
      console.error('Error processing voice message:', error);
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
      console.error('Error converting PCM to WAV:', error);
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
      const channelId = this.runtime.getSetting('DISCORD_VOICE_CHANNEL_ID') as string;
      if (channelId) {
        const channel = await guild.channels.fetch(channelId);
        if (channel?.isVoiceBased()) {
          chosenChannel = channel as BaseGuildVoiceChannel;
        }
      }

      if (!chosenChannel) {
        const channels = (await guild.channels.fetch()).filter(
          (channel) => channel?.type === DiscordChannelType.GuildVoice
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
        logger.debug(`Joining channel: ${chosenChannel.name}`);
        await this.joinChannel(chosenChannel);
      } else {
        logger.debug('Warning: No suitable voice channel found to join.');
      }
    } catch (error) {
      console.error('Error selecting or joining a voice channel:', error);
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
      logger.debug(`No connection for user ${entityId}`);
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

    audioPlayer.on('error', (err: any) => {
      logger.debug(`Audio player error: ${err}`);
    });

    audioPlayer.on('stateChange', (_oldState: any, newState: { status: string }) => {
      if (newState.status === 'idle') {
        const idleTime = Date.now();
        logger.debug(`Audio playback took: ${idleTime - audioStartTime}ms`);
      }
    });
  }

  /**
   * Cleans up the provided audio player by stopping it, removing all listeners,
   * and resetting the active audio player if it matches the provided player.
   *
   * @param {AudioPlayer} audioPlayer - The audio player to be cleaned up.
   */
  cleanupAudioPlayer(audioPlayer: AudioPlayer) {
    if (!audioPlayer) return;

    audioPlayer.stop();
    audioPlayer.removeAllListeners();
    if (audioPlayer === this.activeAudioPlayer) {
      this.activeAudioPlayer = null;
    }
  }

  /**
   * Asynchronously handles the join channel command in an interaction.
   *
   * @param {any} interaction - The interaction object representing the user's input.
   * @returns {Promise<void>} - A promise that resolves once the join channel command is handled.
   */
  async handleJoinChannelCommand(interaction: any) {
    try {
      // Defer the reply immediately to prevent interaction timeout
      await interaction.deferReply();

      const channelId = interaction.options.get('channel')?.value as string;
      if (!channelId) {
        await interaction.editReply('Please provide a voice channel to join.');
        return;
      }

      const guild = interaction.guild;
      if (!guild) {
        await interaction.editReply('Could not find guild.');
        return;
      }

      const voiceChannel = interaction.guild.channels.cache.find(
        (channel: VoiceChannel) =>
          channel.id === channelId && channel.type === DiscordChannelType.GuildVoice
      );

      if (!voiceChannel) {
        await interaction.editReply('Voice channel not found!');
        return;
      }

      await this.joinChannel(voiceChannel as BaseGuildVoiceChannel);
      await interaction.editReply(`Joined voice channel: ${voiceChannel.name}`);
    } catch (error) {
      console.error('Error joining voice channel:', error);
      // Use editReply instead of reply for the error case
      await interaction.editReply('Failed to join the voice channel.').catch(console.error);
    }
  }

  /**
   * Handles the leave channel command by destroying the voice connection if it exists.
   *
   * @param {any} interaction The interaction object representing the command invocation.
   * @returns {void}
   */
  async handleLeaveChannelCommand(interaction: any) {
    const connection = this.getVoiceConnection(interaction.guildId as any);

    if (!connection) {
      await interaction.reply('Not currently in a voice channel.');
      return;
    }

    try {
      connection.destroy();
      await interaction.reply('Left the voice channel.');
    } catch (error) {
      console.error('Error leaving voice channel:', error);
      await interaction.reply('Failed to leave the voice channel.');
    }
  }
}
