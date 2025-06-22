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
   * Handle speech conversation
   */
  async speechConversation(
    agentId: UUID,
    params: SpeechConversationParams
  ): Promise<SpeechResponse> {
    const formData = new FormData();
    
    if (params.audio instanceof Blob) {
      formData.append('audio', params.audio);
    } else if (typeof params.audio === 'string') {
      // Assume it's a base64 string or file path
      formData.append('audio', params.audio);
    } else {
      // Buffer or other types
      formData.append('audio', new Blob([params.audio as Buffer]));
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
  async transcribe(
    agentId: UUID,
    params: TranscribeParams
  ): Promise<TranscriptionResponse> {
    const formData = new FormData();
    
    if (params.audio instanceof Blob) {
      formData.append('audio', params.audio);
    } else if (typeof params.audio === 'string') {
      // Assume it's a base64 string or file path
      formData.append('audio', params.audio);
    } else {
      // Buffer or other types
      formData.append('audio', new Blob([params.audio as Buffer]));
    }
    
    if (params.format) formData.append('format', params.format);
    if (params.language) formData.append('language', params.language);

    return this.request<TranscriptionResponse>('POST', `/api/audio/${agentId}/transcribe`, {
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
    
    if (audio instanceof Blob) {
      formData.append('audio', audio);
    } else if (typeof audio === 'string') {
      formData.append('audio', audio);
    } else {
      formData.append('audio', new Blob([audio as Buffer]));
    }
    
    if (metadata) formData.append('metadata', JSON.stringify(metadata));

    return this.request<SpeechResponse>('POST', `/api/audio/${agentId}/speech`, {
      body: formData,
    });
  }
}