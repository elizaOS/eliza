import { IAgentRuntime, Service, ServiceType, logger } from '@elizaos/core';

// Define transcription-specific types locally since they're not in core
export interface TranscriptionOptions {
  language?: string;
  model?: string;
  prompt?: string;
  temperature?: number;
  timestamps?: boolean;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
  segments?: TranscriptionSegment[];
  words?: TranscriptionWord[];
}

export interface TranscriptionSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  confidence?: number;
}

export interface TranscriptionWord {
  word: string;
  start: number;
  end: number;
  confidence?: number;
}

export interface SpeechToTextOptions extends TranscriptionOptions {
  format?: 'json' | 'text' | 'srt' | 'vtt';
}

export interface TextToSpeechOptions {
  voice?: string;
  speed?: number;
  pitch?: number;
  language?: string;
  format?: 'mp3' | 'wav' | 'ogg';
}

/**
 * Dummy transcription service for testing purposes
 * Provides mock implementations of transcription operations
 */
export class DummyTranscriptionService extends Service {
  static readonly serviceType = ServiceType.TRANSCRIPTION;

  capabilityDescription = 'Dummy transcription service for testing';

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<DummyTranscriptionService> {
    const service = new DummyTranscriptionService(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    logger.info('DummyTranscriptionService initialized');
  }

  async stop(): Promise<void> {
    logger.info('DummyTranscriptionService stopped');
  }

  async transcribeAudio(
    audioBuffer: Buffer,
    options?: TranscriptionOptions
  ): Promise<TranscriptionResult> {
    logger.debug(`Transcribing audio (${audioBuffer.length} bytes)`, JSON.stringify(options));

    // Generate dummy transcription with segments
    const segments: TranscriptionSegment[] = [
      {
        id: 0,
        start: 0,
        end: 5,
        text: 'This is the first segment of dummy transcription.',
        confidence: 0.95,
      },
      {
        id: 1,
        start: 5,
        end: 10,
        text: 'This is the second segment with more text.',
        confidence: 0.92,
      },
      {
        id: 2,
        start: 10,
        end: 15,
        text: 'And this is the final segment of the transcription.',
        confidence: 0.94,
      },
    ];

    const words: TranscriptionWord[] = [
      { word: 'This', start: 0, end: 0.5, confidence: 0.96 },
      { word: 'is', start: 0.5, end: 0.8, confidence: 0.98 },
      { word: 'the', start: 0.8, end: 1.0, confidence: 0.99 },
      { word: 'first', start: 1.0, end: 1.5, confidence: 0.94 },
      { word: 'segment', start: 1.5, end: 2.0, confidence: 0.93 },
    ];

    const result: TranscriptionResult = {
      text: segments.map((s) => s.text).join(' '),
      language: options?.language || 'en',
      duration: 15,
      segments: options?.timestamps ? segments : undefined,
      words: options?.timestamps ? words : undefined,
    };

    logger.debug(`Transcription complete: ${result.text.substring(0, 50)}...`);

    return result;
  }

  async transcribeVideo(
    videoBuffer: Buffer,
    options?: TranscriptionOptions
  ): Promise<TranscriptionResult> {
    logger.debug(`Transcribing video (${videoBuffer.length} bytes)`, JSON.stringify(options));

    // Reuse audio transcription logic for video
    return this.transcribeAudio(videoBuffer, options);
  }

  async speechToText(
    audioBuffer: Buffer,
    options?: SpeechToTextOptions
  ): Promise<string | TranscriptionResult> {
    logger.debug('Converting speech to text', JSON.stringify(options));

    const result = await this.transcribeAudio(audioBuffer, options);

    logger.debug(`Speech to text complete: ${result.text.substring(0, 50)}...`);

    // Return based on format option
    if (options?.format === 'text' || !options?.format) {
      return result.text;
    }

    return result;
  }

  async textToSpeech(text: string, options?: TextToSpeechOptions): Promise<Buffer> {
    logger.debug(
      `Converting text to speech: "${text.substring(0, 50)}..."`,
      JSON.stringify(options)
    );

    // Return dummy audio buffer
    const format = options?.format || 'mp3';
    const dummyAudio = Buffer.from(`dummy-audio-${format}-${text.length}-chars`);

    logger.debug(`Generated ${format} audio: ${dummyAudio.length} bytes`);

    return dummyAudio;
  }

  async detectLanguage(audioBuffer: Buffer): Promise<string> {
    logger.debug(`Detecting language from audio (${audioBuffer.length} bytes)`);

    // Return dummy language code
    return 'en';
  }

  async translateAudio(
    audioBuffer: Buffer,
    targetLanguage: string,
    sourceLanguage?: string
  ): Promise<TranscriptionResult> {
    logger.debug(`Translating audio to ${targetLanguage}`, JSON.stringify({ sourceLanguage }));

    return {
      text: `This is dummy translated text in ${targetLanguage}.`,
      language: targetLanguage,
      duration: 10,
    };
  }

  getDexName(): string {
    return 'dummy-transcription';
  }
}
