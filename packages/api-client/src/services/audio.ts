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
   * Helper to append audio data to FormData.
   */
  private appendAudioToFormData(
    formData: FormData,
    audio: Blob | Buffer | string,
    fieldName = 'audio'
  ): void {
    if (audio instanceof Blob) {
      formData.append(fieldName, audio);
    } else if (typeof audio === 'string') {
      formData.append(fieldName, audio);
    } else {
      formData.append(fieldName, new Blob([audio as Buffer]));
    }
  }

  /**
   * Handle speech conversation
   */
  async speechConversation(
    agentId: UUID,
    params: SpeechConversationParams
  ): Promise<SpeechResponse> {
    const formData = new FormData();
    this.appendAudioToFormData(formData, params.audio);

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
    this.appendAudioToFormData(formData, params.audio);

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
    this.appendAudioToFormData(formData, audio);

    if (metadata) formData.append('metadata', JSON.stringify(metadata));

    return this.request<SpeechResponse>('POST', `/api/audio/${agentId}/speech`, {
      body: formData,
    });
  }
}