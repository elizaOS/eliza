import { UUID } from '@elizaos/core';
import { BaseApiClient } from '../lib/base-client';
import {
  SpeechConversationParams,
  SpeechGenerateParams,
  AudioSynthesizeParams,
  TranscribeParams,
  SpeechResponse,
  TranscriptionResponse,
} from '../types/audio';

export class AudioService extends BaseApiClient {
  /**
   * Convert audio input to appropriate FormData value
   */
  private processAudioInput(audio: Blob | Buffer | string): Blob | string {
    if (audio instanceof Blob) {
      return audio;
    }

    if (typeof audio === 'string') {
      // Handle base64 data URLs (e.g., "data:audio/mp3;base64,...")
      if (audio.startsWith('data:')) {
        try {
          const [header, base64Data] = audio.split(',');
          const mimeMatch = header.match(/data:([^;]+)/);
          const mimeType = mimeMatch ? mimeMatch[1] : 'audio/wav';

          const binaryString = atob(base64Data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          return new Blob([bytes], { type: mimeType });
        } catch (error) {
          throw new Error(
            `Invalid base64 data URL: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }

      // Handle plain base64 strings (try to decode)
      if (this.isBase64String(audio)) {
        try {
          const binaryString = atob(audio);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          return new Blob([bytes], { type: 'audio/wav' });
        } catch (error) {
          // If base64 decoding fails, treat as file path or other string
          return audio;
        }
      }

      // For file paths or other strings, return as-is (server will handle file reading)
      return audio;
    }

    // Handle Buffer and ArrayBuffer types
    if (this.isBuffer(audio)) {
      return new Blob([audio], { type: 'audio/wav' });
    }

    // Cast to any for runtime type checking since TypeScript can't narrow the union type properly
    const audioAsAny = audio as any;

    if (audioAsAny instanceof ArrayBuffer) {
      return new Blob([audioAsAny], { type: 'audio/wav' });
    }

    if (
      audioAsAny &&
      typeof audioAsAny === 'object' &&
      'buffer' in audioAsAny &&
      audioAsAny.buffer instanceof ArrayBuffer
    ) {
      // Handle typed arrays like Uint8Array
      return new Blob([audioAsAny.buffer], { type: 'audio/wav' });
    }

    throw new Error(
      `Unsupported audio input type: ${typeof audio}. Expected Blob, Buffer, ArrayBuffer, or string.`
    );
  }

  /**
   * Check if a string appears to be base64 encoded
   */
  private isBase64String(str: string): boolean {
    // Basic base64 pattern check (allows padding)
    const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;

    // Must be at least 4 characters and divisible by 4 (with padding)
    if (str.length < 4 || str.length % 4 !== 0) {
      return false;
    }

    return base64Pattern.test(str);
  }

  /**
   * Safe check for Buffer type (works in both Node.js and browser environments)
   */
  private isBuffer(obj: any): obj is Buffer {
    return (
      obj != null &&
      typeof obj === 'object' &&
      typeof obj.constructor === 'function' &&
      obj.constructor.name === 'Buffer' &&
      typeof obj.readUInt8 === 'function'
    );
  }

  /**
   * Handle speech conversation
   */
  async speechConversation(
    agentId: UUID,
    params: SpeechConversationParams
  ): Promise<SpeechResponse> {
    const formData = new FormData();

    const processedAudio = this.processAudioInput(params.audio);
    if (processedAudio instanceof Blob) {
      formData.append('audio', processedAudio);
    } else {
      // String (file path or other string identifier)
      formData.append('audio', processedAudio);
    }

    if (params.format) formData.append('format', params.format);
    if (params.language) formData.append('language', params.language);
    if (params.metadata) formData.append('metadata', JSON.stringify(params.metadata));

    return this.request<SpeechResponse>('POST', `/api/audio/${agentId}/speech/conversation`, {
      body: formData,
    });
  }

  /**
   * Generate speech from text
   */
  async generateSpeech(
    agentId: UUID,
    params: SpeechGenerateParams
  ): Promise<{ audio: string; format: string }> {
    return this.post<{ audio: string; format: string }>(
      `/api/audio/${agentId}/speech/generate`,
      params
    );
  }

  /**
   * Synthesize audio message
   */
  async synthesizeAudioMessage(
    agentId: UUID,
    params: AudioSynthesizeParams
  ): Promise<{ audio: string; format: string }> {
    return this.post<{ audio: string; format: string }>(
      `/api/audio/${agentId}/audio-messages/synthesize`,
      params
    );
  }

  /**
   * Transcribe audio to text
   */
  async transcribe(agentId: UUID, params: TranscribeParams): Promise<TranscriptionResponse> {
    const formData = new FormData();

    const processedAudio = this.processAudioInput(params.audio);
    if (processedAudio instanceof Blob) {
      formData.append('audio', processedAudio);
    } else {
      // String (file path or other string identifier)
      formData.append('audio', processedAudio);
    }

    if (params.format) formData.append('format', params.format);
    if (params.language) formData.append('language', params.language);

    return this.request<TranscriptionResponse>('POST', `/api/audio/${agentId}/transcriptions`, {
      body: formData,
    });
  }

  /**
   * Process speech input
   */
  async processSpeech(
    agentId: UUID,
    audio: Blob | Buffer | string,
    metadata?: Record<string, any>
  ): Promise<SpeechResponse> {
    const formData = new FormData();

    const processedAudio = this.processAudioInput(audio);
    if (processedAudio instanceof Blob) {
      formData.append('audio', processedAudio);
    } else {
      // String (file path or other string identifier)
      formData.append('audio', processedAudio);
    }

    if (metadata) formData.append('metadata', JSON.stringify(metadata));

    return this.request<SpeechResponse>('POST', `/api/audio/${agentId}/speech`, {
      body: formData,
    });
  }
}
