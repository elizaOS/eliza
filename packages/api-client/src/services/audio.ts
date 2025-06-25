import { UUID } from '@elizaos/core';
import { BaseApiClient } from '../lib/base-client';
import {
  AudioSynthesizeParams,
  SpeechConversationParams,
  SpeechGenerateParams,
  SpeechResponse,
  TranscribeParams,
  TranscriptionResponse,
} from '../types/audio';

declare const window: any;

export class AudioService extends BaseApiClient {
  /**
   * Make a binary request using BaseApiClient infrastructure
   */
  private async requestBinary(
    method: string,
    path: string,
    options?: {
      body?: any;
      params?: Record<string, any>;
      headers?: Record<string, string>;
    }
  ): Promise<ArrayBuffer> {
    // Handle empty baseUrl for relative URLs
    let url: URL;
    if (this.baseUrl) {
      url = new URL(`${this.baseUrl}${path}`);
    } else if (typeof window !== 'undefined' && window.location) {
      url = new URL(path, window.location.origin);
    } else {
      // Fallback for non-browser environments
      url = new URL(path, 'http://localhost:3000');
    }

    // Add query parameters
    if (options?.params) {
      Object.entries(options.params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, String(value));
        }
      });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers = {
        ...this.defaultHeaders,
        ...options?.headers,
      };

      // Remove Content-Type header if body is FormData
      if (options?.body instanceof FormData) {
        delete headers['Content-Type'];
      }

      const response = await fetch(url.toString(), {
        method,
        headers,
        body:
          options?.body instanceof FormData
            ? options.body
            : options?.body
              ? JSON.stringify(options.body)
              : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return await response.arrayBuffer();
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error('Request timed out');
        }
        throw error;
      }

      throw new Error('An unknown error occurred');
    }
  }

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
      formData.append('file', processedAudio);
    } else {
      // String (file path or other string identifier)
      formData.append('file', processedAudio);
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
    // Get the binary audio data using BaseApiClient infrastructure
    const audioBuffer = await this.requestBinary('POST', `/api/audio/${agentId}/speech/generate`, {
      body: params,
    });

    // Convert to base64
    const bytes = new Uint8Array(audioBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64Audio = btoa(binary);

    // Default format (server should ideally return this in a header)
    const format = 'mpeg';

    return {
      audio: base64Audio,
      format: format,
    };
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
      formData.append('file', processedAudio);
    } else {
      // String (file path or other string identifier)
      formData.append('file', processedAudio);
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
      formData.append('file', processedAudio);
    } else {
      // String (file path or other string identifier)
      formData.append('file', processedAudio);
    }

    if (metadata) formData.append('metadata', JSON.stringify(metadata));

    return this.request<SpeechResponse>('POST', `/api/audio/${agentId}/speech`, {
      body: formData,
    });
  }
}
