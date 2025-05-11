// src/plugins/SttTtsPlugin.ts

import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import {
  ChannelType,
  type Content,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type Plugin,
  createUniqueUuid,
  logger,
} from '@elizaos/core';
import type { ClientBase } from './base';
import type { AudioDataWithUser, JanusClient, Space } from './client';

/**
 * Interface for defining configuration options for a plugin.
 * @typedef {Object} PluginConfig
 * @property {IAgentRuntime} runtime - The runtime environment for the plugin.
 * @property {ClientBase} client - The client to interact with.
 * @property {string} spaceId - The ID of the space the plugin is associated with.
 */
interface PluginConfig {
  runtime: IAgentRuntime;
  client: ClientBase;
  spaceId: string;
}

const VOLUME_WINDOW_SIZE = 100;
const SPEAKING_THRESHOLD = 0.05;
const SILENCE_DETECTION_THRESHOLD_MS = 1000; // 1-second silence threshold

/**
 * MVP plugin for speech-to-text (OpenAI) + conversation + TTS (ElevenLabs)
 * Approach:
 *   - Collect each speaker's unmuted PCM in a memory buffer (only if above silence threshold)
 *   - On speaker mute -> flush STT -> GPT -> TTS -> push to Janus
 */
/**
 * Class representing a plugin for Speech-to-text (OpenAI) + conversation + TTS (ElevenLabs).
 * @class
 */

export class SttTtsPlugin implements Plugin {
  name = 'SttTtsPlugin';
  description = 'Speech-to-text (OpenAI) + conversation + TTS (ElevenLabs)';
  private runtime: IAgentRuntime;
  private spaceId: string;

  private space?: Space;
  private janus?: JanusClient;

  /**
   * userId => arrayOfChunks (PCM Int16)
   */
  private pcmBuffers = new Map<string, Int16Array[]>();

  // TTS queue for sequentially speaking
  private ttsQueue: string[] = [];
  private isSpeaking = false;
  private isProcessingAudio = false;

  private userSpeakingTimer: NodeJS.Timer | null = null;
  private volumeBuffers: Map<string, number[]>;
  private ttsAbortController: AbortController | null = null;

  onAttach(_space: Space) {
    logger.log('[SttTtsPlugin] onAttach => space was attached');
  }

  async init(params): Promise<void> {
    logger.log('[SttTtsPlugin] init => Space fully ready. Subscribing to events.');

    this.space = params.space;
    this.janus = (this.space as any)?.janusClient as JanusClient | undefined;

    const config = params.pluginConfig as PluginConfig;
    this.runtime = config?.runtime;
    this.spaceId = config?.spaceId;

    this.volumeBuffers = new Map<string, number[]>();
  }

  /**
   * Called whenever we receive PCM from a speaker
   */
  onAudioData(data: AudioDataWithUser): void {
    if (this.isProcessingAudio) {
      return;
    }
    /**
     * For ignoring near-silence frames (if amplitude < threshold)
     */
    const silenceThreshold = 50;
    let maxVal = 0;
    for (let i = 0; i < data.samples.length; i++) {
      const val = Math.abs(data.samples[i]);
      if (val > maxVal) maxVal = val;
    }
    if (maxVal < silenceThreshold) {
      return;
    }

    if (this.userSpeakingTimer) {
      clearTimeout(this.userSpeakingTimer);
    }

    let arr = this.pcmBuffers.get(data.userId);
    if (!arr) {
      arr = [];
      this.pcmBuffers.set(data.userId, arr);
    }
    arr.push(data.samples);

    if (!this.isSpeaking) {
      this.userSpeakingTimer = setTimeout(() => {
        logger.log('[SttTtsPlugin] start processing audio for user =>', data.userId);
        this.userSpeakingTimer = null;
        this.processAudio(data.userId).catch((err) =>
          logger.error('[SttTtsPlugin] handleSilence error =>', err)
        );
      }, SILENCE_DETECTION_THRESHOLD_MS);
    } else {
      // check interruption
      let volumeBuffer = this.volumeBuffers.get(data.userId);
      if (!volumeBuffer) {
        volumeBuffer = [];
        this.volumeBuffers.set(data.userId, volumeBuffer);
      }
      const samples = new Int16Array(
        data.samples.buffer,
        data.samples.byteOffset,
        data.samples.length / 2
      );
      const maxAmplitude = Math.max(...samples.map(Math.abs)) / 32768;
      volumeBuffer.push(maxAmplitude);

      if (volumeBuffer.length > VOLUME_WINDOW_SIZE) {
        volumeBuffer.shift();
      }
      const avgVolume = volumeBuffer.reduce((sum, v) => sum + v, 0) / VOLUME_WINDOW_SIZE;

      if (avgVolume > SPEAKING_THRESHOLD) {
        volumeBuffer.length = 0;
        if (this.ttsAbortController) {
          this.ttsAbortController.abort();
          this.isSpeaking = false;
          logger.log('[SttTtsPlugin] TTS playback interrupted');
        }
      }
    }
  }

  // /src/sttTtsPlugin.ts
  private async convertPcmToWavInMemory(
    pcmData: Int16Array,
    sampleRate: number
  ): Promise<ArrayBuffer> {
    // number of channels
    const numChannels = 1;
    // byte rate = (sampleRate * numChannels * bitsPerSample/8)
    const byteRate = sampleRate * numChannels * 2;
    const blockAlign = numChannels * 2;
    // data chunk size = pcmData.length * (bitsPerSample/8)
    const dataSize = pcmData.length * 2;

    // WAV header is 44 bytes
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // RIFF chunk descriptor
    this.writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true); // file size - 8
    this.writeString(view, 8, 'WAVE');

    // fmt sub-chunk
    this.writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
    view.setUint16(22, numChannels, true); // NumChannels
    view.setUint32(24, sampleRate, true); // SampleRate
    view.setUint32(28, byteRate, true); // ByteRate
    view.setUint16(32, blockAlign, true); // BlockAlign
    view.setUint16(34, 16, true); // BitsPerSample (16)

    // data sub-chunk
    this.writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // Write PCM samples
    let offset = 44;
    for (let i = 0; i < pcmData.length; i++, offset += 2) {
      view.setInt16(offset, pcmData[i], true);
    }

    return buffer;
  }

  private writeString(view: DataView, offset: number, text: string) {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  }

  /**
   * On speaker silence => flush STT => GPT => TTS => push to Janus
   */
  private async processAudio(userId: string): Promise<void> {
    if (this.isProcessingAudio) {
      return;
    }
    this.isProcessingAudio = true;
    try {
      logger.log('[SttTtsPlugin] Starting audio processing for user:', userId);
      const chunks = this.pcmBuffers.get(userId) || [];
      this.pcmBuffers.clear();

      if (!chunks.length) {
        logger.warn('[SttTtsPlugin] No audio chunks for user =>', userId);
        return;
      }
      logger.log(`[SttTtsPlugin] Flushing STT buffer for user=${userId}, chunks=${chunks.length}`);

      const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
      const merged = new Int16Array(totalLen);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }

      // Convert PCM to WAV for STT
      const wavBuffer = await this.convertPcmToWavInMemory(merged, 48000);

      // Whisper STT
      const sttText = await this.runtime.useModel(ModelType.TRANSCRIPTION, wavBuffer);

      logger.log(`[SttTtsPlugin] Transcription result: "${sttText}"`);

      if (!sttText || !sttText.trim()) {
        logger.warn('[SttTtsPlugin] No speech recognized for user =>', userId);
        return;
      }
      logger.log(`[SttTtsPlugin] STT => user=${userId}, text="${sttText}"`);

      // Get response
      await this.handleUserMessage(sttText, userId);
    } catch (error) {
      logger.error('[SttTtsPlugin] processAudio error =>', error);
    } finally {
      this.isProcessingAudio = false;
    }
  }

  /**
   * Public method to queue a TTS request
   */
  public async speakText(text: string): Promise<void> {
    this.ttsQueue.push(text);
    if (!this.isSpeaking) {
      this.isSpeaking = true;
      this.processTtsQueue().catch((err) => {
        logger.error('[SttTtsPlugin] processTtsQueue error =>', err);
      });
    }
  }

  /**
   * Process TTS requests one by one
   */
  private async processTtsQueue(): Promise<void> {
    while (this.ttsQueue.length > 0) {
      const text = this.ttsQueue.shift();
      if (!text) continue;

      this.ttsAbortController = new AbortController();
      const { signal } = this.ttsAbortController;

      try {
        const responseStream = await this.runtime.useModel(ModelType.TEXT_TO_SPEECH, text);
        if (!responseStream) {
          logger.error('[SttTtsPlugin] TTS responseStream is null');
          continue;
        }

        logger.log('[SttTtsPlugin] Received ElevenLabs TTS stream');

        // Convert the Readable Stream to PCM and stream to Janus
        await this.streamTtsStreamToJanus(responseStream, 48000, signal);

        if (signal.aborted) {
          logger.log('[SttTtsPlugin] TTS interrupted after streaming');
          return;
        }
      } catch (err) {
        logger.error('[SttTtsPlugin] TTS streaming error =>', err);
      } finally {
        // Clean up the AbortController
        this.ttsAbortController = null;
      }
    }
    this.isSpeaking = false;
  }

  /**
   * Handle User Message
   */
  private async handleUserMessage(
    userText: string,
    userId: string // This is the raw Twitter user ID like 'tw-1865462035586142208'
  ): Promise<string> {
    if (!userText || userText.trim() === '') {
      return null;
    }

    // Extract the numeric ID part
    const numericId = userId.replace('tw-', '');
    const roomId = createUniqueUuid(this.runtime, `twitter_generate_room-${this.spaceId}`);

    // Create consistent UUID for the user
    const userUuid = createUniqueUuid(this.runtime, numericId);

    const entity = await this.runtime.getEntityById(userUuid);
    if (!entity) {
      await this.runtime.createEntity({
        id: userUuid,
        names: [userId],
        agentId: this.runtime.agentId,
      });
    }

    // Ensure room exists and user is in it
    await this.runtime.ensureConnection({
      entityId: userUuid,
      roomId: roomId,
      name: 'Twitter Space',
      source: 'twitter',
      type: ChannelType.VOICE_GROUP,
      channelId: null,
      serverId: this.spaceId,
      worldId: createUniqueUuid(this.runtime, this.spaceId),
    });

    const memory = {
      id: createUniqueUuid(this.runtime, `${roomId}-voice-message-${Date.now()}`),
      agentId: this.runtime.agentId,
      content: {
        text: userText,
        source: 'twitter',
      },
      userId: userUuid,
      roomId,
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
            user: this.runtime.character.name,
            inReplyTo: memory.id,
            isVoiceMessage: true,
          },
          roomId,
          createdAt: Date.now(),
        };

        if (responseMemory.content.text?.trim()) {
          await this.runtime.createMemory(responseMemory, 'messages');
          this.isProcessingAudio = false;
          this.volumeBuffers.clear();
          await this.speakText(content.text);
        }

        return [responseMemory];
      } catch (error) {
        console.error('Error in voice message callback:', error);
        return [];
      }
    };

    // Emit voice-specific events
    this.runtime.emitEvent(EventType.VOICE_MESSAGE_RECEIVED, {
      runtime: this.runtime,
      message: memory,
      callback,
    });
  }

  /**
   * Convert MP3 => PCM via ffmpeg
   */
  private convertMp3ToPcm(mp3Buf: Buffer, outRate: number): Promise<Int16Array> {
    return new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-i',
        'pipe:0',
        '-f',
        's16le',
        '-ar',
        outRate.toString(),
        '-ac',
        '1',
        'pipe:1',
      ]);
      let raw = Buffer.alloc(0);

      ff.stdout.on('data', (chunk: Buffer) => {
        raw = Buffer.concat([raw, chunk]);
      });
      ff.stderr.on('data', () => {
        // ignoring ffmpeg logs
      });
      ff.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg error code=${code}`));
          return;
        }
        const samples = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
        resolve(samples);
      });

      ff.stdin.write(mp3Buf);
      ff.stdin.end();
    });
  }

  /**
   * Push PCM back to Janus in small frames
   * We'll do 10ms @48k => 960 samples per frame
   */
  private async streamToJanus(samples: Int16Array, sampleRate: number): Promise<void> {
    // TODO: Check if better than 480 fixed
    const FRAME_SIZE = Math.floor(sampleRate * 0.01); // 10ms frames => 480 @48kHz

    for (let offset = 0; offset + FRAME_SIZE <= samples.length; offset += FRAME_SIZE) {
      if (this.ttsAbortController?.signal.aborted) {
        logger.log('[SttTtsPlugin] streamToJanus interrupted');
        return;
      }
      const frame = new Int16Array(FRAME_SIZE);
      frame.set(samples.subarray(offset, offset + FRAME_SIZE));
      this.janus?.pushLocalAudio(frame, sampleRate, 1);

      // Short pause so we don't overload
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private async streamTtsStreamToJanus(
    stream: Readable,
    sampleRate: number,
    signal: AbortSignal
  ): Promise<void> {
    const chunks: Buffer[] = [];

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        if (signal.aborted) {
          logger.log('[SttTtsPlugin] Stream aborted, stopping playback');
          stream.destroy();
          reject(new Error('TTS streaming aborted'));
          return;
        }
        chunks.push(chunk);
      });

      stream.on('end', async () => {
        if (signal.aborted) {
          logger.log('[SttTtsPlugin] Stream ended but was aborted');
          return reject(new Error('TTS streaming aborted'));
        }

        const mp3Buffer = Buffer.concat(chunks);

        try {
          // Convert MP3 to PCM
          const pcmSamples = await this.convertMp3ToPcm(mp3Buffer, sampleRate);

          // Stream PCM to Janus
          await this.streamToJanus(pcmSamples, sampleRate);
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      stream.on('error', (error) => {
        logger.error('[SttTtsPlugin] Error in TTS stream', error);
        reject(error);
      });
    });
  }

  cleanup(): void {
    logger.log('[SttTtsPlugin] cleanup => releasing resources');
    this.pcmBuffers.clear();
    this.userSpeakingTimer = null;
    this.ttsQueue = [];
    this.isSpeaking = false;
    this.volumeBuffers.clear();
  }
}
