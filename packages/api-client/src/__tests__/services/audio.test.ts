import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { AudioService } from '../../services/audio';
import { ApiClientConfig } from '../../types/base';
import { UUID } from '@elizaos/core';

// Helper type to access protected/private methods in tests
type MockableAudioService = AudioService & {
  request: ReturnType<typeof mock>;
  post: ReturnType<typeof mock>;
  requestBinary: ReturnType<typeof mock>;
  processAudioInput: (audio: Blob | Buffer | string) => Blob | string;
};

// Test UUIDs in proper format
const TEST_AGENT_ID = '550e8400-e29b-41d4-a716-446655440001' as UUID;

describe('AudioService', () => {
  let audioService: MockableAudioService;
  const mockConfig: ApiClientConfig = {
    baseUrl: 'http://localhost:3000',
    apiKey: 'test-key',
  };

  beforeEach(() => {
    audioService = new AudioService(mockConfig) as MockableAudioService;
    // Mock the HTTP methods
    audioService.request = mock(() => Promise.resolve({}));
    audioService.post = mock(() => Promise.resolve({}));
  });

  afterEach(() => {
    const requestMock = audioService.request;
    const postMock = audioService.post;
    if (requestMock?.mockClear) {
      requestMock.mockClear();
    }
    if (postMock?.mockClear) {
      postMock.mockClear();
    }
  });

  describe('constructor', () => {
    it('should create an instance with valid configuration', () => {
      expect(audioService).toBeInstanceOf(AudioService);
    });

    it('should throw error when initialized with invalid configuration', () => {
      // Testing error handling with null config
      expect(() => new AudioService(null as ApiClientConfig)).toThrow();
    });
  });

  describe('speechConversation', () => {
    const mockAudioBlob = new Blob(['audio data'], { type: 'audio/wav' });
    const params = {
      audio: mockAudioBlob,
      format: 'wav' as const,
      language: 'en',
    };

    it('should handle speech conversation successfully', async () => {
      const mockResponse = { text: 'Hello there!', audio: 'base64-audio-data', duration: 2.5 };
      audioService.request.mockResolvedValue(mockResponse);

      const result = await audioService.speechConversation(TEST_AGENT_ID, params);

      expect(audioService.request).toHaveBeenCalledWith(
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
      audioService.request.mockResolvedValue(mockResponse);

      await audioService.speechConversation(TEST_AGENT_ID, params);

      expect(audioService.request).toHaveBeenCalled();
    });

    it('should handle string audio input', async () => {
      const stringParams = { ...params, audio: 'audio-string-data' };
      audioService.request.mockResolvedValue({ response: 'Success' });

      await audioService.speechConversation(TEST_AGENT_ID, stringParams);

      expect(audioService.request).toHaveBeenCalled();
    });
  });

  describe('Audio Processing Bug Fixes', () => {
    beforeEach(() => {
      audioService.request.mockResolvedValue({ text: 'Hello world' });
    });

    it('should handle base64 data URL strings correctly', async () => {
      // Create a valid base64 data URL
      const base64Audio =
        'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAIB+AAABAAgAZGF0YQA=';

      await audioService.speechConversation(TEST_AGENT_ID, { audio: base64Audio });

      expect(audioService.request).toHaveBeenCalledWith(
        'POST',
        `/api/audio/${TEST_AGENT_ID}/speech/conversation`,
        expect.objectContaining({
          body: expect.any(FormData),
        })
      );
    });

    it('should handle plain base64 strings correctly', async () => {
      // Create a valid base64 string (without data URL prefix)
      const base64String = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAIB+AAABAAgAZGF0YQA=';

      await audioService.speechConversation(TEST_AGENT_ID, { audio: base64String });

      expect(audioService.request).toHaveBeenCalledWith(
        'POST',
        `/api/audio/${TEST_AGENT_ID}/speech/conversation`,
        expect.objectContaining({
          body: expect.any(FormData),
        })
      );
    });

    it('should handle file path strings correctly', async () => {
      const filePath = '/path/to/audio.wav';

      await audioService.speechConversation(TEST_AGENT_ID, { audio: filePath });

      expect(audioService.request).toHaveBeenCalledWith(
        'POST',
        `/api/audio/${TEST_AGENT_ID}/speech/conversation`,
        expect.objectContaining({
          body: expect.any(FormData),
        })
      );
    });

    it('should handle Buffer objects safely', async () => {
      // Create a proper mock Buffer-like object that will pass isBuffer check
      const mockBuffer = {
        constructor: { name: 'Buffer' },
        readUInt8: mock(() => 0),
        // Mock Buffer data
        *[Symbol.iterator]() {
          yield 1;
          yield 2;
          yield 3;
        },
        length: 3,
      };

      // Mock the processAudioInput method to handle our mock buffer
      const originalProcessAudioInput = audioService.processAudioInput;
      audioService.processAudioInput = mock((audio: Blob | Buffer | string) => {
        // Mock buffer is Buffer-like but not a real Buffer instance
        if (audio === (mockBuffer as Buffer)) {
          return new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
        }
        return originalProcessAudioInput.call(audioService, audio);
      });

      // Mock buffer is Buffer-like and will be handled by processAudioInput
      await audioService.speechConversation(TEST_AGENT_ID, { audio: mockBuffer as Buffer });

      expect(audioService.request).toHaveBeenCalledWith(
        'POST',
        `/api/audio/${TEST_AGENT_ID}/speech/conversation`,
        expect.objectContaining({
          body: expect.any(FormData),
        })
      );
    });

    it('should handle ArrayBuffer objects correctly', async () => {
      const arrayBuffer = new ArrayBuffer(8);
      // ArrayBuffer will be converted by processAudioInput - testing type compatibility
      await audioService.speechConversation(TEST_AGENT_ID, { audio: arrayBuffer as Buffer });

      expect(audioService.request).toHaveBeenCalledWith(
        'POST',
        `/api/audio/${TEST_AGENT_ID}/speech/conversation`,
        expect.objectContaining({
          body: expect.any(FormData),
        })
      );
    });

    it('should handle Uint8Array objects correctly', async () => {
      const uint8Array = new Uint8Array([1, 2, 3, 4]);
      // Uint8Array will be converted by processAudioInput - testing type compatibility
      await audioService.speechConversation(TEST_AGENT_ID, { audio: uint8Array as Buffer });

      expect(audioService.request).toHaveBeenCalledWith(
        'POST',
        `/api/audio/${TEST_AGENT_ID}/speech/conversation`,
        expect.objectContaining({
          body: expect.any(FormData),
        })
      );
    });

    it('should throw error for unsupported audio types', async () => {
      const unsupportedAudio = { some: 'object' };
      // Testing error handling with invalid audio type
      await expect(
        audioService.speechConversation(TEST_AGENT_ID, {
          audio: unsupportedAudio as Blob | Buffer | string,
        })
      ).rejects.toThrow('Unsupported audio input type: object');
    });

    it('should throw error for invalid base64 data URL', async () => {
      const invalidBase64 = 'data:audio/wav;base64,invalid-base64!!!';

      await expect(
        audioService.speechConversation(TEST_AGENT_ID, { audio: invalidBase64 })
      ).rejects.toThrow('Invalid base64 data URL');
    });
  });

  describe('generateSpeech', () => {
    const params = {
      text: 'Hello world',
      voice: 'default',
      format: 'mp3',
    };

    it('should generate speech successfully', async () => {
      // Mock the internal requestBinary method instead of post
      const mockAudioBuffer = new ArrayBuffer(16);
      const mockUint8Array = new Uint8Array(mockAudioBuffer);
      // Fill with some test data
      for (let i = 0; i < mockUint8Array.length; i++) {
        mockUint8Array[i] = i;
      }

      audioService.requestBinary = mock(() => Promise.resolve(mockAudioBuffer));

      const result = await audioService.generateSpeech(TEST_AGENT_ID, params);

      expect(audioService.requestBinary).toHaveBeenCalledWith(
        'POST',
        `/api/audio/${TEST_AGENT_ID}/speech/generate`,
        { body: params }
      );
      expect(result).toHaveProperty('audio');
      expect(result).toHaveProperty('format');
      expect(typeof result.audio).toBe('string');
      expect(result.format).toBe('mpeg');
    });
  });

  describe('synthesizeAudioMessage', () => {
    const params = {
      messageId: TEST_AGENT_ID,
      voice: 'natural',
    };

    it('should synthesize audio message successfully', async () => {
      const mockResponse = { audio: 'synthesized-audio', format: 'wav' };
      audioService.post.mockResolvedValue(mockResponse);

      const result = await audioService.synthesizeAudioMessage(TEST_AGENT_ID, params);

      expect(audioService.post).toHaveBeenCalledWith(
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
      format: 'wav' as const,
      language: 'en',
    };

    it('should transcribe audio successfully', async () => {
      const mockResponse = { text: 'Transcribed text', confidence: 0.95 };
      audioService.request.mockResolvedValue(mockResponse);

      const result = await audioService.transcribe(TEST_AGENT_ID, params);

      expect(audioService.request).toHaveBeenCalledWith(
        'POST',
        `/api/audio/${TEST_AGENT_ID}/transcriptions`,
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
      const mockResponse = { text: 'Processed response', audio: 'response-audio', duration: 1.5 };
      audioService.request.mockResolvedValue(mockResponse);

      const result = await audioService.processSpeech(TEST_AGENT_ID, audioBlob, metadata);

      expect(audioService.request).toHaveBeenCalledWith(
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
      audioService.request.mockResolvedValue(mockResponse);

      await audioService.processSpeech(TEST_AGENT_ID, audioBlob);

      expect(audioService.request).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle network errors', async () => {
      audioService.request.mockRejectedValue(new Error('Network error'));

      await expect(
        audioService.speechConversation(TEST_AGENT_ID, { audio: new Blob() })
      ).rejects.toThrow('Network error');
    });

    it('should handle API errors', async () => {
      audioService.requestBinary = mock(() => Promise.reject(new Error('API error')));

      await expect(audioService.generateSpeech(TEST_AGENT_ID, { text: 'test' })).rejects.toThrow(
        'API error'
      );
    });
  });
});
