import { Service, type IAgentRuntime, logger } from '@elizaos/core';
import SamJs from 'sam-js';
import { SAMServiceType } from '../types';

export interface SamTTSOptions {
  speed?: number; // 0-255, default 72
  pitch?: number; // 0-255, default 64
  throat?: number; // 0-255, default 128
  mouth?: number; // 0-255, default 128
}

/**
 * SAM TTS Service
 *
 * Provides retro text-to-speech using the SAM Speech Synthesizer.
 * Generates 8-bit audio buffers that can be streamed through the hardware bridge.
 */
export class SamTTSService extends Service {
  public static serviceType = SAMServiceType.SAM_TTS;

  private defaultOptions: SamTTSOptions;

  constructor(runtime?: IAgentRuntime) {
    super();

    this.runtime = runtime;

    // Default SAM voice settings
    this.defaultOptions = {
      speed: 72, // Normal speaking speed
      pitch: 64, // Normal pitch
      throat: 128, // Normal throat setting
      mouth: 128, // Normal mouth setting
    };
  }

  static async start(runtime: IAgentRuntime): Promise<SamTTSService> {
    const service = new SamTTSService(runtime);
    logger.info('[SAM-TTS] SAM TTS Service initialized');
    return service;
  }

  async stop(): Promise<void> {
    logger.info('[SAM-TTS] SAM TTS Service stopped');
  }

  /**
   * Generate audio buffer from text using SAM TTS
   */
  async generateAudio(text: string, options: SamTTSOptions = {}): Promise<Uint8Array> {
    // Handle empty text
    if (!text || text.trim().length === 0) {
      logger.info('[SAM-TTS] Empty text provided, returning silent buffer');
      return new Uint8Array(100); // Return a small silent buffer
    }

    const opts = { ...this.defaultOptions, ...options };

    logger.info(
      `[SAM-TTS] Generating audio for: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`
    );
    logger.info(
      `[SAM-TTS] Settings - Speed: ${opts.speed}, Pitch: ${opts.pitch}, Throat: ${opts.throat}, Mouth: ${opts.mouth}`
    );

    // Create new SAM instance with parameters (correct API)
    const sam = new SamJs({
      speed: opts.speed,
      pitch: opts.pitch,
      throat: opts.throat,
      mouth: opts.mouth,
    });

    // Generate 8-bit audio buffer
    const audioResult = sam.buf8(text);

    // Handle both boolean and Uint8Array returns
    const audioBuffer: Uint8Array = audioResult as Uint8Array;

    logger.info(`[SAM-TTS] Generated ${audioBuffer.length} bytes of audio data`);
    return audioBuffer;
  }

  /**
   * Generate audio and send to hardware bridge for playback
   */
  async speakText(text: string, options: SamTTSOptions = {}): Promise<Uint8Array> {
    // Generate SAM audio
    const audioBuffer = await this.generateAudio(text, options);

    // Convert Uint8Array to WAV format buffer
    const wavBuffer = this.createWAVBuffer(audioBuffer);

    // Get hardware bridge service from runtime
    interface HardwareBridgeService {
      sendAudioData: (audioBuffer: Uint8Array) => Promise<void>;
      isConnected?: () => boolean;
      capabilityDescription?: string;
    }

    const hardwareBridge = this.runtime.getService(
      'hardwareBridge'
    ) as unknown as HardwareBridgeService | null;

    if (!hardwareBridge) {
      logger.warn(
        '[SAM-TTS] Hardware bridge service not available - audio cannot be sent to speakers'
      );
      return audioBuffer; // Return the buffer anyway for testing/other uses
    }

    logger.info('[SAM-TTS] Sending audio to hardware bridge...');
    await hardwareBridge.sendAudioData(wavBuffer);
    logger.info('[SAM-TTS] ✅ Audio sent to hardware bridge successfully');
    return audioBuffer;
  }

  /**
   * Create WAV file buffer from raw 8-bit audio data
   */
  createWAVBuffer(audioData: Uint8Array, sampleRate: number = 22050): Uint8Array {
    const numChannels = 1; // Mono
    const bitsPerSample = 8; // 8-bit audio

    const dataSize = audioData.length;
    const fileSize = 36 + dataSize;

    // Create WAV header
    const buffer = new Uint8Array(44 + dataSize);
    const view = new DataView(buffer.buffer);
    let offset = 0;

    // RIFF header
    buffer.set([0x52, 0x49, 0x46, 0x46], offset);
    offset += 4; // "RIFF"
    view.setUint32(offset, fileSize, true);
    offset += 4;
    buffer.set([0x57, 0x41, 0x56, 0x45], offset);
    offset += 4; // "WAVE"

    // Format chunk
    buffer.set([0x66, 0x6d, 0x74, 0x20], offset);
    offset += 4; // "fmt "
    view.setUint32(offset, 16, true);
    offset += 4; // Subchunk1Size
    view.setUint16(offset, 1, true);
    offset += 2; // AudioFormat (PCM)
    view.setUint16(offset, numChannels, true);
    offset += 2;
    view.setUint32(offset, sampleRate, true);
    offset += 4;
    view.setUint32(offset, (sampleRate * numChannels * bitsPerSample) / 8, true);
    offset += 4; // ByteRate
    view.setUint16(offset, (numChannels * bitsPerSample) / 8, true);
    offset += 2; // BlockAlign
    view.setUint16(offset, bitsPerSample, true);
    offset += 2;

    // Data chunk
    buffer.set([0x64, 0x61, 0x74, 0x61], offset);
    offset += 4; // "data"
    view.setUint32(offset, dataSize, true);
    offset += 4;

    // Audio data
    buffer.set(audioData, offset);

    return buffer;
  }

  /**
   * Get service capabilities description
   */
  get capabilityDescription(): string {
    return 'SAM TTS Service: Retro 1980s text-to-speech synthesis with hardware bridge integration';
  }

  /**
   * Test if SAM TTS is working
   */
  async testSynthesis(): Promise<boolean> {
    const testText = 'SAM is working correctly';
    const audioBuffer = await this.generateAudio(testText);
    return audioBuffer.length > 0;
  }
}
