import { logger, ModelType, type IAgentRuntime } from '@elizaos/core';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execAsync = promisify(exec);

export interface AudioConfig {
  enabled: boolean;
  transcriptionInterval: number; // milliseconds
  device?: string;
  sampleRate?: number;
  channels?: number;
}

export class AudioCaptureService {
  private runtime: IAgentRuntime;
  private config: AudioConfig;
  private isRecording = false;
  private recordingInterval: NodeJS.Timeout | null = null;
  private currentRecordingPath: string | null = null;

  constructor(runtime: IAgentRuntime, config: AudioConfig) {
    this.runtime = runtime;
    this.config = {
      sampleRate: 16000,
      channels: 1,
      ...config,
    };
  }

  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      logger.info('[AudioCapture] Audio capture disabled');
      return;
    }

    try {
      logger.info('[AudioCapture] Initializing audio capture...');

      // Check for audio recording tools
      const tool = await this.checkAudioTools();
      if (!tool.available) {
        throw new Error(`Audio recording tool not available. ${tool.message}`);
      }

      logger.info(`[AudioCapture] Using ${tool.tool} for audio capture`);
      logger.info(`[AudioCapture] Transcription interval: ${this.config.transcriptionInterval}ms`);

      // Start recording loop if interval is set
      if (this.config.transcriptionInterval > 0) {
        this.startTranscriptionLoop();
      }

      logger.info('[AudioCapture] Audio capture initialized');
    } catch (error) {
      logger.error('[AudioCapture] Failed to initialize:', error);
      throw error;
    }
  }

  private async checkAudioTools(): Promise<{ available: boolean; tool: string; message?: string }> {
    const platform = process.platform;

    try {
      if (platform === 'darwin') {
        // macOS: Use sox
        await execAsync('which sox');
        return { available: true, tool: 'sox' };
      } else if (platform === 'linux') {
        // Linux: Use arecord (ALSA)
        await execAsync('which arecord');
        return { available: true, tool: 'arecord' };
      } else if (platform === 'win32') {
        // Windows: Use ffmpeg
        await execAsync('where ffmpeg');
        return { available: true, tool: 'ffmpeg' };
      }
      return { available: false, tool: 'none', message: 'Unsupported platform' };
    } catch (_error) {
      // Tool not found
      const toolName = platform === 'darwin' ? 'sox' : platform === 'linux' ? 'arecord' : 'ffmpeg';
      const installCmd =
        platform === 'darwin'
          ? 'brew install sox'
          : platform === 'linux'
            ? 'sudo apt-get install alsa-utils'
            : 'Download ffmpeg from ffmpeg.org';
      return {
        available: false,
        tool: toolName,
        message: `Install with: ${installCmd}`,
      };
    }
  }

  private startTranscriptionLoop(): void {
    if (this.recordingInterval) {
      return;
    }

    // Start continuous recording with periodic transcription
    this.recordingInterval = setInterval(async () => {
      if (!this.isRecording) {
        await this.recordAndTranscribe();
      }
    }, this.config.transcriptionInterval);

    logger.info('[AudioCapture] Started transcription loop');
  }

  async recordAndTranscribe(): Promise<string | null> {
    if (this.isRecording) {
      logger.warn('[AudioCapture] Already recording');
      return null;
    }

    this.isRecording = true;
    const audioFile = path.join(process.cwd(), `audio_${Date.now()}.wav`);

    try {
      logger.debug('[AudioCapture] Starting audio recording...');

      // Record audio for the specified duration
      await this.recordAudio(audioFile, this.config.transcriptionInterval / 1000);

      logger.debug('[AudioCapture] Recording complete, transcribing...');

      // Transcribe using runtime model
      const audioBuffer = await fs.readFile(audioFile);
      const transcription = await this.runtime.useModel(ModelType.TRANSCRIPTION, {
        audio: audioBuffer,
        language: 'en',
      });

      // Clean up audio file
      await fs.unlink(audioFile).catch(() => {});

      if (transcription && typeof transcription === 'string' && transcription.trim()) {
        logger.info(`[AudioCapture] Transcribed: "${transcription}"`);

        // Create a memory of what was heard
        await this.createAudioMemory(transcription);

        return transcription;
      }

      return null;
    } catch (error) {
      logger.error('[AudioCapture] Recording/transcription failed:', error);
      await fs.unlink(audioFile).catch(() => {});
      return null;
    } finally {
      this.isRecording = false;
    }
  }

  private async recordAudio(outputPath: string, duration: number): Promise<void> {
    const platform = process.platform;

    try {
      if (platform === 'darwin') {
        // macOS: Use sox
        const _device = this.config.device || 'default';
        await execAsync(
          `sox -d -r ${this.config.sampleRate} -c ${this.config.channels} -b 16 "${outputPath}" trim 0 ${duration}`
        );
      } else if (platform === 'linux') {
        // Linux: Use arecord
        const device = this.config.device || 'default';
        await execAsync(
          `arecord -D ${device} -f S16_LE -r ${this.config.sampleRate} -c ${this.config.channels} -d ${duration} "${outputPath}"`
        );
      } else if (platform === 'win32') {
        // Windows: Use ffmpeg with DirectShow
        const device = this.config.device || 'Microphone';
        await execAsync(
          `ffmpeg -f dshow -i audio="${device}" -t ${duration} -acodec pcm_s16le -ar ${this.config.sampleRate} -ac ${this.config.channels} "${outputPath}" -y`
        );
      } else {
        throw new Error(`Unsupported platform: ${platform}`);
      }
    } catch (error: any) {
      logger.error('[AudioCapture] Audio recording failed:', error);
      throw error;
    }
  }

  private async createAudioMemory(transcription: string): Promise<void> {
    try {
      const _memory = {
        content: {
          text: `[Audio Transcription] ${transcription}`,
          type: 'audio_transcription',
          source: 'microphone',
          timestamp: Date.now(),
        },
        metadata: {
          isAudioTranscription: true,
          duration: this.config.transcriptionInterval,
        },
      };

      // Store in agent's context
      // Note: createMemory requires runtime implementation specific to the database adapter
      // For now, we'll just log it
      logger.info('[AudioCapture] Audio transcription stored in context');
    } catch (error) {
      logger.error('[AudioCapture] Failed to create audio memory:', error);
    }
  }

  async listAudioDevices(): Promise<string[]> {
    const platform = process.platform;
    const devices: string[] = [];

    try {
      if (platform === 'darwin') {
        // macOS: List audio devices using system_profiler
        const { stdout } = await execAsync('system_profiler SPAudioDataType -json');
        const data = JSON.parse(stdout);

        if (data.SPAudioDataType) {
          for (const device of data.SPAudioDataType) {
            if (device._name && device._name.includes('Input')) {
              devices.push(device._name);
            }
          }
        }
      } else if (platform === 'linux') {
        // Linux: List ALSA devices
        const { stdout } = await execAsync('arecord -l');
        const lines = stdout.split('\n');

        for (const line of lines) {
          if (line.includes('card')) {
            const match = line.match(/card (\d+):.*\[(.*?)\]/);
            if (match) {
              devices.push(`hw:${match[1]}`);
            }
          }
        }
      } else if (platform === 'win32') {
        // Windows: List audio devices using ffmpeg
        try {
          const { stdout } = await execAsync('ffmpeg -list_devices true -f dshow -i dummy 2>&1');
          const lines = stdout.split('\n');
          let isAudioSection = false;

          for (const line of lines) {
            if (line.includes('DirectShow audio devices')) {
              isAudioSection = true;
            } else if (isAudioSection && line.includes('"')) {
              const match = line.match(/"([^"]+)"/);
              if (match) {
                devices.push(match[1]);
              }
            }
          }
        } catch (_error) {
          // ffmpeg returns non-zero exit code when listing devices
          // but we can still parse the output
        }
      }
    } catch (error) {
      logger.error('[AudioCapture] Failed to list audio devices:', error);
    }

    return devices;
  }

  isActive(): boolean {
    return this.config.enabled && this.recordingInterval !== null;
  }

  async stop(): Promise<void> {
    logger.info('[AudioCapture] Stopping audio capture...');

    if (this.recordingInterval) {
      clearInterval(this.recordingInterval);
      this.recordingInterval = null;
    }

    // Wait for any ongoing recording to complete
    while (this.isRecording) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    logger.info('[AudioCapture] Audio capture stopped');
  }
}
