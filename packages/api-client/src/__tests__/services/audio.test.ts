import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { AudioService } from '../../services/audio';
import { ApiClientConfig } from '../../types/base';
import { UUID } from '@elizaos/core';

// Test UUIDs in proper format
const TEST_AGENT_ID = '550e8400-e29b-41d4-a716-446655440001' as UUID;

describe('AudioService', () => {
  let audioService: AudioService;
  const mockConfig: ApiClientConfig = {
    baseUrl: 'http://localhost:3000',
    apiKey: 'test-key',
  };

  beforeEach(() => {
    audioService = new AudioService(mockConfig);
    // Mock the HTTP methods
    (audioService as any).request = mock(() => Promise.resolve({}));
    (audioService as any).post = mock(() => Promise.resolve({}));
  });

  afterEach(() => {
    const requestMock = (audioService as any).request;
    const postMock = (audioService as any).post;
    if (requestMock?.mockClear) requestMock.mockClear();
    if (postMock?.mockClear) postMock.mockClear();
  });

  describe('constructor', () => {
    it('should create an instance with valid configuration', () => {
      expect(audioService).toBeInstanceOf(AudioService);
    });

    it('should throw error when initialized with invalid configuration', () => {
      expect(() => new AudioService(null as any)).toThrow();
    });
  });

  describe('speechConversation', () => {
    const mockAudioBlob = new Blob(['audio data'], { type: 'audio/wav' });
    const params = {
      audio: mockAudioBlob,
      format: 'wav',
      language: 'en',
    };

    it('should handle speech conversation successfully', async () => {
      const mockResponse = { response: 'Hello there!', audioUrl: 'http://example.com/audio.wav' };
      (audioService as any).request.mockResolvedValue(mockResponse);

      const result = await audioService.speechConversation(TEST_AGENT_ID, params);

      expect((audioService as any).request).toHaveBeenCalledWith(
        'POST',
        `/api/audio/${TEST_AGENT_ID}/speech/conversation`,
        expect.objectContaining({
          body: expect.any(FormData),
        })
      );
      expect(result).toEqual(mockResponse);
    });

    it('should handle audio blob input', async () => {
      const mockResponse = { response: 'Success' };
      (audioService as any).request.mockResolvedValue(mockResponse);

      await audioService.speechConversation(TEST_AGENT_ID, params);

      expect((audioService as any).request).toHaveBeenCalled();
    });

    it('should handle string audio input', async () => {
      const stringParams = { ...params, audio: 'audio-string-data' };
      (audioService as any).request.mockResolvedValue({ response: 'Success' });

      await audioService.speechConversation(TEST_AGENT_ID, stringParams);

      expect((audioService as any).request).toHaveBeenCalled();
    });
  });

  describe('generateSpeech', () => {
    const params = {
      text: 'Hello world',
      voice: 'default',
      format: 'mp3',
    };

    it('should generate speech successfully', async () => {
      const mockResponse = { audio: 'base64-audio-data', format: 'mp3' };
      (audioService as any).post.mockResolvedValue(mockResponse);

      const result = await audioService.generateSpeech(TEST_AGENT_ID, params);

      expect((audioService as any).post).toHaveBeenCalledWith(
        `/api/audio/${TEST_AGENT_ID}/speech/generate`,
        params
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('synthesizeAudioMessage', () => {
    const params = {
      text: 'Message to synthesize',
      voice: 'natural',
    };

    it('should synthesize audio message successfully', async () => {
      const mockResponse = { audio: 'synthesized-audio', format: 'wav' };
      (audioService as any).post.mockResolvedValue(mockResponse);

      const result = await audioService.synthesizeAudioMessage(TEST_AGENT_ID, params);

      expect((audioService as any).post).toHaveBeenCalledWith(
        `/api/audio/${TEST_AGENT_ID}/audio-messages/synthesize`,
        params
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('transcribe', () => {
    const audioBlob = new Blob(['audio data'], { type: 'audio/wav' });
    const params = {
      audio: audioBlob,
      format: 'wav',
      language: 'en',
    };

    it('should transcribe audio successfully', async () => {
      const mockResponse = { text: 'Transcribed text', confidence: 0.95 };
      (audioService as any).request.mockResolvedValue(mockResponse);

      const result = await audioService.transcribe(TEST_AGENT_ID, params);

      expect((audioService as any).request).toHaveBeenCalledWith(
        'POST',
        `/api/audio/${TEST_AGENT_ID}/transcribe`,
        expect.objectContaining({
          body: expect.any(FormData),
        })
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('processSpeech', () => {
    const audioBlob = new Blob(['speech data'], { type: 'audio/wav' });
    const metadata = { sessionId: 'session-123' };

    it('should process speech successfully', async () => {
      const mockResponse = { response: 'Processed response', action: 'continue' };
      (audioService as any).request.mockResolvedValue(mockResponse);

      const result = await audioService.processSpeech(TEST_AGENT_ID, audioBlob, metadata);

      expect((audioService as any).request).toHaveBeenCalledWith(
        'POST',
        `/api/audio/${TEST_AGENT_ID}/speech`,
        expect.objectContaining({
          body: expect.any(FormData),
        })
      );
      expect(result).toEqual(mockResponse);
    });

    it('should handle speech processing without metadata', async () => {
      const mockResponse = { response: 'Processed' };
      (audioService as any).request.mockResolvedValue(mockResponse);

      await audioService.processSpeech(TEST_AGENT_ID, audioBlob);

      expect((audioService as any).request).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle network errors', async () => {
      (audioService as any).request.mockRejectedValue(new Error('Network error'));

      await expect(audioService.speechConversation(TEST_AGENT_ID, { audio: new Blob() }))
        .rejects.toThrow('Network error');
    });

    it('should handle API errors', async () => {
      (audioService as any).post.mockRejectedValue(new Error('API error'));

      await expect(audioService.generateSpeech(TEST_AGENT_ID, { text: 'test' }))
        .rejects.toThrow('API error');
    });
  });
});