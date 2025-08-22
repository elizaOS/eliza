import { Service, ServiceType } from './service';

export interface TranscriptionOptions {
  language?: string;
  model?: string;
  temperature?: number;
  prompt?: string;
  response_format?: 'json' | 'text' | 'srt' | 'vtt' | 'verbose_json';
  timestamp_granularities?: ('word' | 'segment')[];
  word_timestamps?: boolean;
  segment_timestamps?: boolean;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
  segments?: TranscriptionSegment[];
  words?: TranscriptionWord[];
  confidence?: number;
}

export interface TranscriptionSegment {
  id: number;
  text: string;
  start: number;
  end: number;
  confidence?: number;
  tokens?: number[];
  temperature?: number;
  avg_logprob?: number;
  compression_ratio?: number;
  no_speech_prob?: number;
}

export interface TranscriptionWord {
  word: string;
  start: number;
  end: number;
  confidence?: number;
}

export interface SpeechToTextOptions {
  language?: string;
  model?: string;
  continuous?: boolean;
  interimResults?: boolean;
  maxAlternatives?: number;
}

export interface TextToSpeechOptions {
  voice?: string;
  model?: string;
  speed?: number;
  format?: 'mp3' | 'wav' | 'flac' | 'aac';
  response_format?: 'mp3' | 'opus' | 'aac' | 'flac';
}

/**
 * Interface for audio transcription and speech services
 */
export abstract class ITranscriptionService extends Service {
  static override readonly serviceType = ServiceType.TRANSCRIPTION;

  public readonly capabilityDescription = 'Audio transcription and speech processing capabilities';

  /**
   * Transcribe audio file to text
   * @param audioPath - Path to audio file or audio buffer
   * @param options - Transcription options
   * @returns Promise resolving to transcription result
   */
  abstract transcribeAudio(
    audioPath: string | Buffer,
    options?: TranscriptionOptions
  ): Promise<TranscriptionResult>;

  /**
   * Transcribe video file to text (extracts audio first)
   * @param videoPath - Path to video file or video buffer
   * @param options - Transcription options
   * @returns Promise resolving to transcription result
   */
  abstract transcribeVideo(
    videoPath: string | Buffer,
    options?: TranscriptionOptions
  ): Promise<TranscriptionResult>;

  /**
   * Real-time speech to text from audio stream
   * @param audioStream - Audio stream or buffer
   * @param options - Speech to text options
   * @returns Promise resolving to transcription result
   */
  abstract speechToText(
    audioStream: NodeJS.ReadableStream | Buffer,
    options?: SpeechToTextOptions
  ): Promise<TranscriptionResult>;

  /**
   * Convert text to speech
   * @param text - Text to convert to speech
   * @param options - Text to speech options
   * @returns Promise resolving to audio buffer
   */
  abstract textToSpeech(text: string, options?: TextToSpeechOptions): Promise<Buffer>;

  /**
   * Get supported languages for transcription
   * @returns Promise resolving to array of supported language codes
   */
  abstract getSupportedLanguages(): Promise<string[]>;

  /**
   * Get available voices for text to speech
   * @returns Promise resolving to array of available voices
   */
  abstract getAvailableVoices(): Promise<
    Array<{
      id: string;
      name: string;
      language: string;
      gender?: 'male' | 'female' | 'neutral';
    }>
  >;

  /**
   * Detect language of audio file
   * @param audioPath - Path to audio file or audio buffer
   * @returns Promise resolving to detected language code
   */
  abstract detectLanguage(audioPath: string | Buffer): Promise<string>;
}
