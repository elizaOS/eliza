import { logger, ModelType, type IAgentRuntime } from '@elizaos/core';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export interface StreamingAudioConfig {
  enabled: boolean;
  device?: string;
  sampleRate?: number;
  channels?: number;
  vadThreshold?: number; // 0-1, energy threshold for speech detection
  silenceTimeout?: number; // ms to wait before considering speech ended
  responseDelay?: number; // ms to wait before processing (for interruption detection)
  chunkSize?: number; // bytes per chunk for streaming
}

interface AudioChunk {
  data: Buffer;
  timestamp: number;
  energy: number;
}

export class StreamingAudioCaptureService extends EventEmitter {
  private runtime: IAgentRuntime;
  private config: StreamingAudioConfig;
  private captureProcess: ChildProcess | null = null;
  private isCapturing = false;
  private audioBuffer: AudioChunk[] = [];
  private isSpeaking = false;
  private lastSpeechTime = 0;
  private silenceTimer: NodeJS.Timeout | null = null;
  private transcriptionInProgress = false;
  private currentTranscription = '';
  private responseTimer: NodeJS.Timeout | null = null;

  constructor(runtime: IAgentRuntime, config: StreamingAudioConfig) {
    super();
    this.runtime = runtime;
    this.config = {
      sampleRate: 16000,
      channels: 1,
      vadThreshold: 0.01,
      silenceTimeout: 1500, // 1.5 seconds of silence to end speech
      responseDelay: 3000, // 3 seconds before response (allows for interruption)
      chunkSize: 4096,
      ...config,
    };
  }

  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      logger.info('[StreamingAudio] Audio capture disabled');
      return;
    }

    try {
      logger.info('[StreamingAudio] Initializing streaming audio capture...');

      // Start continuous audio capture
      await this.startContinuousCapture();

      logger.info('[StreamingAudio] Streaming audio capture initialized');
    } catch (error) {
      logger.error('[StreamingAudio] Failed to initialize:', error);
      throw error;
    }
  }

  private async startContinuousCapture(): Promise<void> {
    const platform = process.platform;
    let command: string;
    let args: string[];

    if (platform === 'darwin') {
      // macOS: Use sox for continuous capture
      command = 'sox';
      args = [
        '-d', // default input device
        '-r',
        this.config.sampleRate!.toString(),
        '-c',
        this.config.channels!.toString(),
        '-b',
        '16',
        '-e',
        'signed',
        '-t',
        'raw',
        '-', // output to stdout
      ];
    } else if (platform === 'linux') {
      // Linux: Use arecord
      command = 'arecord';
      args = [
        '-D',
        this.config.device || 'default',
        '-f',
        'S16_LE',
        '-r',
        this.config.sampleRate!.toString(),
        '-c',
        this.config.channels!.toString(),
        '-t',
        'raw',
        '-', // output to stdout
      ];
    } else if (platform === 'win32') {
      // Windows: Use ffmpeg
      command = 'ffmpeg';
      args = [
        '-f',
        'dshow',
        '-i',
        `audio="${this.config.device || 'Microphone'}"`,
        '-acodec',
        'pcm_s16le',
        '-ar',
        this.config.sampleRate!.toString(),
        '-ac',
        this.config.channels!.toString(),
        '-f',
        's16le',
        'pipe:1', // output to stdout
      ];
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    this.captureProcess = spawn(command, args);
    this.isCapturing = true;

    // Handle audio data stream
    this.captureProcess.stdout?.on('data', (chunk: Buffer) => {
      this.processAudioChunk(chunk);
    });

    this.captureProcess.stderr?.on('data', (data) => {
      logger.debug('[StreamingAudio] Capture stderr:', data.toString());
    });

    this.captureProcess.on('error', (error) => {
      logger.error('[StreamingAudio] Capture process error:', error);
      this.isCapturing = false;
    });

    this.captureProcess.on('exit', (code) => {
      logger.info('[StreamingAudio] Capture process exited with code:', code);
      this.isCapturing = false;
    });
  }

  private processAudioChunk(chunk: Buffer): void {
    // Calculate audio energy for VAD
    const energy = this.calculateEnergy(chunk);
    const timestamp = Date.now();

    // Store chunk
    const audioChunk: AudioChunk = { data: chunk, timestamp, energy };

    // Voice Activity Detection
    if (energy > this.config.vadThreshold!) {
      if (!this.isSpeaking) {
        // Speech started
        this.isSpeaking = true;
        this.lastSpeechTime = timestamp;
        logger.debug('[StreamingAudio] Speech detected, starting recording');
        this.emit('speechStart');

        // Clear any pending response
        if (this.responseTimer) {
          clearTimeout(this.responseTimer);
          this.responseTimer = null;
          logger.debug('[StreamingAudio] Cancelled pending response due to new speech');
        }
      }

      // Add to buffer
      this.audioBuffer.push(audioChunk);
      this.lastSpeechTime = timestamp;

      // Reset silence timer
      if (this.silenceTimer) {
        clearTimeout(this.silenceTimer);
      }

      // Start streaming transcription if not already running
      if (!this.transcriptionInProgress) {
        this.startStreamingTranscription();
      }
    } else if (this.isSpeaking) {
      // Currently in speech but detected silence
      this.audioBuffer.push(audioChunk);

      // Set timer for end of speech
      if (!this.silenceTimer) {
        this.silenceTimer = setTimeout(() => {
          this.endSpeech();
        }, this.config.silenceTimeout!);
      }
    }

    // Clean up old chunks (keep last 30 seconds)
    const cutoffTime = timestamp - 30000;
    this.audioBuffer = this.audioBuffer.filter((c) => c.timestamp > cutoffTime);
  }

  private calculateEnergy(chunk: Buffer): number {
    // Calculate RMS energy of audio chunk
    let sum = 0;
    const samples = chunk.length / 2; // 16-bit samples

    for (let i = 0; i < chunk.length; i += 2) {
      const sample = chunk.readInt16LE(i);
      sum += sample * sample;
    }

    const rms = Math.sqrt(sum / samples);
    return rms / 32768; // Normalize to 0-1
  }

  private async startStreamingTranscription(): Promise<void> {
    if (this.transcriptionInProgress) {
      return;
    }

    this.transcriptionInProgress = true;
    logger.debug('[StreamingAudio] Starting streaming transcription');

    try {
      // Get audio data from buffer
      const audioData = this.getRecentAudioData();

      if (audioData.length === 0) {
        this.transcriptionInProgress = false;
        return;
      }

      // Use streaming transcription if available, otherwise batch
      const result = await this.transcribeAudio(audioData);

      if (result && result.trim()) {
        this.currentTranscription = result;
        logger.info(`[StreamingAudio] Partial transcription: "${result}"`);
        this.emit('transcription', { text: result, isFinal: false });
      }
    } catch (error) {
      logger.error('[StreamingAudio] Transcription error:', error);
    }

    this.transcriptionInProgress = false;

    // Continue transcription if still speaking
    if (this.isSpeaking) {
      setTimeout(() => this.startStreamingTranscription(), 500);
    }
  }

  private endSpeech(): void {
    if (!this.isSpeaking) {
      return;
    }

    this.isSpeaking = false;
    this.silenceTimer = null;
    logger.debug('[StreamingAudio] Speech ended');
    this.emit('speechEnd');

    // Get final transcription
    this.processFinalTranscription();
  }

  private async processFinalTranscription(): Promise<void> {
    const audioData = this.getRecentAudioData();

    if (audioData.length === 0) {
      return;
    }

    try {
      // Get final transcription
      const finalText = await this.transcribeAudio(audioData);

      if (finalText && finalText.trim()) {
        this.currentTranscription = finalText;
        logger.info(`[StreamingAudio] Final transcription: "${finalText}"`);
        this.emit('transcription', { text: finalText, isFinal: true });

        // Set timer for response generation
        this.responseTimer = setTimeout(() => {
          this.generateResponse(finalText);
        }, this.config.responseDelay!);
      }
    } catch (error) {
      logger.error('[StreamingAudio] Final transcription error:', error);
    } finally {
      // Clear audio buffer
      this.audioBuffer = [];
      this.currentTranscription = '';
    }
  }

  private getRecentAudioData(): Buffer {
    if (this.audioBuffer.length === 0) {
      return Buffer.alloc(0);
    }

    // Get audio from start of speech to now
    const startTime = this.audioBuffer[0].timestamp;
    const relevantChunks = this.audioBuffer.filter((c) => c.timestamp >= startTime);

    // Combine chunks
    const totalLength = relevantChunks.reduce((sum, c) => sum + c.data.length, 0);
    const combined = Buffer.alloc(totalLength);
    let offset = 0;

    for (const chunk of relevantChunks) {
      chunk.data.copy(combined, offset);
      offset += chunk.data.length;
    }

    return combined;
  }

  private async transcribeAudio(audioData: Buffer): Promise<string | null> {
    try {
      // Convert raw audio to WAV format
      const wavBuffer = this.rawToWav(audioData);

      // Use runtime transcription model
      const result = await this.runtime.useModel(ModelType.TRANSCRIPTION, {
        audio: wavBuffer,
        language: 'en',
        stream: true, // Request streaming if supported
      });

      return result as string;
    } catch (error) {
      logger.error('[StreamingAudio] Transcription failed:', error);
      return null;
    }
  }

  private rawToWav(rawData: Buffer): Buffer {
    // Create WAV header
    const sampleRate = this.config.sampleRate!;
    const channels = this.config.channels!;
    const bitsPerSample = 16;
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const dataSize = rawData.length;
    const fileSize = 36 + dataSize;

    const header = Buffer.alloc(44);

    // RIFF chunk
    header.write('RIFF', 0);
    header.writeUInt32LE(fileSize, 4);
    header.write('WAVE', 8);

    // fmt chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // fmt chunk size
    header.writeUInt16LE(1, 20); // PCM format
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);

    // data chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, rawData]);
  }

  private async generateResponse(transcription: string): Promise<void> {
    this.responseTimer = null;

    try {
      // Create audio memory
      await this.createAudioMemory(transcription);

      // Emit event for response generation
      this.emit('utteranceComplete', transcription);
    } catch (error) {
      logger.error('[StreamingAudio] Response generation error:', error);
    }
  }

  private async createAudioMemory(transcription: string): Promise<void> {
    try {
      const _memory = {
        content: {
          text: `[Audio] ${transcription}`,
          type: 'audio_transcription',
          source: 'microphone_streaming',
          timestamp: Date.now(),
        },
        metadata: {
          isAudioTranscription: true,
          streaming: true,
        },
      };

      logger.info('[StreamingAudio] Audio transcription stored in context');
    } catch (error) {
      logger.error('[StreamingAudio] Failed to create audio memory:', error);
    }
  }

  async stop(): Promise<void> {
    logger.info('[StreamingAudio] Stopping audio capture...');

    if (this.captureProcess) {
      this.captureProcess.kill();
      this.captureProcess = null;
    }

    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }

    if (this.responseTimer) {
      clearTimeout(this.responseTimer);
      this.responseTimer = null;
    }

    this.isCapturing = false;
    this.isSpeaking = false;
    this.audioBuffer = [];

    logger.info('[StreamingAudio] Audio capture stopped');
  }

  isActive(): boolean {
    return this.isCapturing;
  }

  getCurrentTranscription(): string {
    return this.currentTranscription;
  }

  isSpeechActive(): boolean {
    return this.isSpeaking;
  }
}
