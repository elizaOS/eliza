import { IAgentRuntime } from '@elizaos/core';
import {
  ITranscriptionService,
  TranscriptionOptions,
  TranscriptionResult,
  TranscriptionSegment,
  TranscriptionWord,
  SpeechToTextOptions,
  TextToSpeechOptions,
} from '@elizaos/core';

/**
 * Dummy transcription service for testing purposes
 * Provides mock implementations of transcription operations
 */
export class DummyTranscriptionService extends ITranscriptionService {
  static override readonly serviceType = ITranscriptionService.serviceType;

  private supportedLanguages = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'zh', 'ja', 'ko'];
  private availableVoices = [
    { id: 'en-US-male', name: 'John', language: 'en-US', gender: 'male' as const },
    { id: 'en-US-female', name: 'Jane', language: 'en-US', gender: 'female' as const },
    { id: 'es-ES-male', name: 'Carlos', language: 'es-ES', gender: 'male' as const },
    { id: 'fr-FR-female', name: 'Marie', language: 'fr-FR', gender: 'female' as const },
  ];

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<DummyTranscriptionService> {
    const service = new DummyTranscriptionService(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    this.runtime.logger.info('DummyTranscriptionService initialized');
  }

  async stop(): Promise<void> {
    this.runtime.logger.info('DummyTranscriptionService stopped');
  }

  async transcribeAudio(
    audioPath: string | Buffer,
    options?: TranscriptionOptions
  ): Promise<TranscriptionResult> {
    const filename = Buffer.isBuffer(audioPath) ? 'audio-buffer' : audioPath;
    this.runtime.logger.debug(`Transcribing audio from ${filename}`);

    if (options) {
      this.runtime.logger.debug('Transcription options:', options);
    }

    // Mock transcription result
    const mockText =
      'Hello, this is a mock transcription from the dummy service. The audio has been processed and converted to text. This demonstrates the transcription capabilities of the system.';

    const words: TranscriptionWord[] = mockText.split(' ').map((word, index) => ({
      word: word.replace(/[.,!?]/, ''),
      start: index * 0.5,
      end: (index + 1) * 0.5,
      confidence: 0.9 + Math.random() * 0.1,
    }));

    const segments: TranscriptionSegment[] = [
      {
        id: 0,
        text: 'Hello, this is a mock transcription from the dummy service.',
        start: 0,
        end: 5,
        confidence: 0.95,
        temperature: 0.0,
        avg_logprob: -0.1,
        compression_ratio: 1.2,
        no_speech_prob: 0.01,
      },
      {
        id: 1,
        text: 'The audio has been processed and converted to text.',
        start: 5,
        end: 10,
        confidence: 0.92,
        temperature: 0.0,
        avg_logprob: -0.12,
        compression_ratio: 1.1,
        no_speech_prob: 0.02,
      },
      {
        id: 2,
        text: 'This demonstrates the transcription capabilities of the system.',
        start: 10,
        end: 15,
        confidence: 0.89,
        temperature: 0.0,
        avg_logprob: -0.15,
        compression_ratio: 1.3,
        no_speech_prob: 0.03,
      },
    ];

    return {
      text: mockText,
      language: options?.language || 'en',
      duration: 15,
      segments: options?.response_format === 'verbose_json' ? segments : undefined,
      words: options?.word_timestamps ? words : undefined,
      confidence: 0.92,
    };
  }

  async transcribeVideo(
    videoPath: string | Buffer,
    options?: TranscriptionOptions
  ): Promise<TranscriptionResult> {
    const filename = Buffer.isBuffer(videoPath) ? 'video-buffer' : videoPath;
    this.runtime.logger.debug(`Transcribing video from ${filename}`);

    // For video, we simulate extracting audio first, then transcribing
    const mockText =
      "This is a mock transcription from a video file. The video's audio track has been extracted and processed. The speaker discusses various topics including technology, AI, and automation systems.";

    const words: TranscriptionWord[] = mockText.split(' ').map((word, index) => ({
      word: word.replace(/[.,!?]/, ''),
      start: index * 0.6,
      end: (index + 1) * 0.6,
      confidence: 0.85 + Math.random() * 0.15,
    }));

    return {
      text: mockText,
      language: options?.language || 'en',
      duration: 20,
      words: options?.word_timestamps ? words : undefined,
      confidence: 0.88,
    };
  }

  async speechToText(
    audioStream: NodeJS.ReadableStream | Buffer,
    options?: SpeechToTextOptions
  ): Promise<TranscriptionResult> {
    this.runtime.logger.debug('Processing real-time speech to text');

    if (options) {
      this.runtime.logger.debug('Speech to text options:', options);
    }

    // Mock real-time transcription
    const mockText =
      'Real-time speech recognition is working. This is a continuous transcription from the audio stream.';

    return {
      text: mockText,
      language: options?.language || 'en',
      duration: 5,
      confidence: 0.85,
    };
  }

  async textToSpeech(text: string, options?: TextToSpeechOptions): Promise<Buffer> {
    this.runtime.logger.debug(`Converting text to speech: "${text.substring(0, 50)}..."`);

    if (options) {
      this.runtime.logger.debug('Text to speech options:', options);
    }

    // Mock audio generation
    const mockAudioData = `Mock audio data for: ${text}`;
    const audioBuffer = Buffer.from(mockAudioData, 'utf8');

    // Simulate processing time based on text length
    await new Promise((resolve) => setTimeout(resolve, Math.min(text.length * 10, 1000)));

    return audioBuffer;
  }

  async getSupportedLanguages(): Promise<string[]> {
    return [...this.supportedLanguages];
  }

  async getAvailableVoices(): Promise<
    Array<{
      id: string;
      name: string;
      language: string;
      gender?: 'male' | 'female' | 'neutral';
    }>
  > {
    return [...this.availableVoices];
  }

  async detectLanguage(audioPath: string | Buffer): Promise<string> {
    const filename = Buffer.isBuffer(audioPath) ? 'audio-buffer' : audioPath;
    this.runtime.logger.debug(`Detecting language from ${filename}`);

    // Mock language detection - randomly pick a supported language
    const randomLanguage =
      this.supportedLanguages[Math.floor(Math.random() * this.supportedLanguages.length)];

    // Simulate processing time
    await new Promise((resolve) => setTimeout(resolve, 100));

    return randomLanguage;
  }
}
