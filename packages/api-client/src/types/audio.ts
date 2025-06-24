import { UUID } from '@elizaos/core';

export interface SpeechConversationParams {
  audio: Blob | Buffer | string;
  format?: 'mp3' | 'wav' | 'ogg' | 'webm';
  language?: string;
  metadata?: Record<string, any>;
}

export interface SpeechGenerateParams {
  text: string;
  voice?: string;
  language?: string;
  speed?: number;
  pitch?: number;
}

export interface AudioSynthesizeParams {
  messageId: UUID;
  voice?: string;
  format?: 'mp3' | 'wav' | 'ogg';
}

export interface TranscribeParams {
  audio: Blob | Buffer | string;
  format?: 'mp3' | 'wav' | 'ogg' | 'webm';
  language?: string;
}

export interface SpeechResponse {
  text?: string;
  audio?: string;
  duration?: number;
  metadata?: Record<string, any>;
}

export interface TranscriptionResponse {
  text: string;
  language?: string;
  confidence?: number;
  words?: Array<{
    word: string;
    start: number;
    end: number;
    confidence?: number;
  }>;
}
