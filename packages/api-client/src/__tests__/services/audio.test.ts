import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { AudioService } from '../../services/audio';
import { AudioConfig, AudioResponse } from '../../types/audio';

jest.mock('../../utils/http-client');

describe('AudioService', () => {
  let audioService: AudioService;
  let mockHttpClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockHttpClient = {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
    };
    audioService = new AudioService(mockHttpClient);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create an instance with valid configuration', () => {
      const config: AudioConfig = { baseUrl: 'https://api.example.com', apiKey: 'test-key' };
      const service = new AudioService(config);
      expect(service).toBeInstanceOf(AudioService);
    });

    it('should throw error when initialized with invalid configuration', () => {
      // @ts-ignore - testing invalid parameters
      expect(() => new AudioService(null)).toThrow();
      // @ts-ignore - testing invalid parameters
      expect(() => new AudioService({})).toThrow();
    });

    it('should set default configuration when no config provided', () => {
      const service = new AudioService();
      expect(service).toBeInstanceOf(AudioService);
    });
  });

  describe('uploadAudio', () => {
    const mockAudioFile = new File(['audio data'], 'test.mp3', { type: 'audio/mpeg' });
    const mockUploadResponse: AudioResponse = { id: 'audio-123', url: 'https://example.com/audio.mp3' };

    it('should upload audio file successfully', async () => {
      mockHttpClient.post.mockResolvedValue({ data: mockUploadResponse });

      const result = await audioService.uploadAudio(mockAudioFile);

      expect(mockHttpClient.post).toHaveBeenCalledWith('/audio/upload', expect.any(FormData));
      expect(result).toEqual(mockUploadResponse);
    });

    it('should handle upload failure', async () => {
      mockHttpClient.post.mockRejectedValue(new Error('Upload failed'));

      await expect(audioService.uploadAudio(mockAudioFile)).rejects.toThrow('Upload failed');
    });

    it('should validate file type before upload', async () => {
      const invalidFile = new File(['data'], 'test.txt', { type: 'text/plain' });

      await expect(audioService.uploadAudio(invalidFile)).rejects.toThrow('Invalid file type');
    });

    it('should validate file size limits', async () => {
      const largeContent = 'x'.repeat(100 * 1024 * 1024);
      const largeFile = new File([largeContent], 'large.mp3', { type: 'audio/mpeg' });

      await expect(audioService.uploadAudio(largeFile)).rejects.toThrow('File too large');
    });
  });

  describe('getAudio', () => {
    const mockAudioId = 'audio-123';
    const mockAudioData: AudioResponse = { id: mockAudioId, name: 'test.mp3', duration: 180 };

    it('should retrieve audio by id successfully', async () => {
      mockHttpClient.get.mockResolvedValue({ data: mockAudioData });

      const result = await audioService.getAudio(mockAudioId);

      expect(mockHttpClient.get).toHaveBeenCalledWith(`/audio/${mockAudioId}`);
      expect(result).toEqual(mockAudioData);
    });

    it('should handle audio not found', async () => {
      mockHttpClient.get.mockRejectedValue(new Error('Audio not found'));

      await expect(audioService.getAudio('nonexistent')).rejects.toThrow('Audio not found');
    });

    it('should validate audio id parameter', async () => {
      // @ts-ignore - testing invalid types
      await expect(audioService.getAudio('')).rejects.toThrow('Invalid audio id');
      // @ts-ignore
      await expect(audioService.getAudio(null)).rejects.toThrow('Invalid audio id');
      // @ts-ignore
      await expect(audioService.getAudio(undefined)).rejects.toThrow('Invalid audio id');
    });
  });

  describe('listAudio', () => {
    const mockAudioList: AudioResponse[] = [
      { id: 'audio-1', name: 'file1.mp3', duration: 120 },
      { id: 'audio-2', name: 'file2.mp3', duration: 240 }
    ];

    it('should list all audio files', async () => {
      mockHttpClient.get.mockResolvedValue({ data: mockAudioList });

      const result = await audioService.listAudio();

      expect(mockHttpClient.get).toHaveBeenCalledWith('/audio');
      expect(result).toEqual(mockAudioList);
    });

    it('should handle pagination parameters', async () => {
      const options = { page: 2, limit: 10 };
      mockHttpClient.get.mockResolvedValue({ data: mockAudioList });

      const result = await audioService.listAudio(options);

      expect(mockHttpClient.get).toHaveBeenCalledWith('/audio', { params: options });
      expect(result).toEqual(mockAudioList);
    });
  });

  describe('processAudio', () => {
    const mockProcessingOptions = { format: 'mp3', bitrate: 128, normalize: true };
    const mockProcessedAudio: AudioResponse = { id: 'processed-123', url: 'https://example.com/processed.mp3' };

    it('should process audio with valid options', async () => {
      mockHttpClient.post.mockResolvedValue({ data: mockProcessedAudio });

      const result = await audioService.processAudio('audio-123', mockProcessingOptions);

      expect(mockHttpClient.post).toHaveBeenCalledWith('/audio/audio-123/process', mockProcessingOptions);
      expect(result).toEqual(mockProcessedAudio);
    });

    it('should handle processing errors', async () => {
      mockHttpClient.post.mockRejectedValue(new Error('Processing failed'));

      await expect(audioService.processAudio('audio-123', mockProcessingOptions))
        .rejects.toThrow('Processing failed');
    });

    it('should validate processing options', async () => {
      const invalidOptions = { format: 'invalid', bitrate: -1 };

      await expect(audioService.processAudio('audio-123', invalidOptions as any))
        .rejects.toThrow('Invalid processing options');
    });
  });

  describe('deleteAudio', () => {
    it('should delete audio successfully', async () => {
      mockHttpClient.delete.mockResolvedValue({ data: { success: true } });

      const result = await audioService.deleteAudio('audio-123');

      expect(mockHttpClient.delete).toHaveBeenCalledWith('/audio/audio-123');
      expect(result).toEqual({ success: true });
    });

    it('should handle deletion of non-existent audio', async () => {
      mockHttpClient.delete.mockRejectedValue(new Error('Audio not found'));

      await expect(audioService.deleteAudio('nonexistent')).rejects.toThrow('Audio not found');
    });
  });

  describe('edge cases and error handling', () => {
    it('should handle network timeouts', async () => {
      mockHttpClient.get.mockRejectedValue(new Error('Network timeout'));

      await expect(audioService.getAudio('audio-123')).rejects.toThrow('Network timeout');
    });

    it('should handle rate limiting', async () => {
      mockHttpClient.post.mockRejectedValue({ status: 429, message: 'Rate limit exceeded' });

      await expect(audioService.uploadAudio(new File([''], 'test.mp3', { type: 'audio/mpeg' })))
        .rejects.toMatchObject({ status: 429 });
    });

    it('should handle authentication errors', async () => {
      mockHttpClient.get.mockRejectedValue({ status: 401, message: 'Unauthorized' });

      await expect(audioService.listAudio()).rejects.toMatchObject({ status: 401 });
    });

    it('should handle server errors gracefully', async () => {
      mockHttpClient.get.mockRejectedValue({ status: 500, message: 'Internal server error' });

      await expect(audioService.getAudio('audio-123')).rejects.toMatchObject({ status: 500 });
    });
  });

  describe('configuration and setup', () => {
    it('should use custom headers when provided', () => {
      const customHeaders = { 'X-Custom-Header': 'test-value' };
      const service = new AudioService({ headers: customHeaders } as AudioConfig);

      expect(service).toBeInstanceOf(AudioService);
    });

    it('should handle API key authentication', () => {
      const service = new AudioService({ apiKey: 'test-api-key' } as AudioConfig);

      expect(service).toBeInstanceOf(AudioService);
    });
  });
});

// Test utilities and helpers
const createMockAudioFile = (name = 'test.mp3', type = 'audio/mpeg', size = 1024): File => {
  const content = 'x'.repeat(size);
  return new File([content], name, { type });
};

const createMockAudioResponse = (overrides: Partial<AudioResponse> = {}): AudioResponse => ({
  id: 'audio-123',
  name: 'test.mp3',
  duration: 180,
  url: 'https://example.com/audio.mp3',
  ...overrides
});

// Performance and load testing helpers
const runConcurrentRequests = async (service: AudioService, count = 10) => {
  const promises = Array(count).fill(null).map((_, i) =>
    service.getAudio(`audio-${i}`)
  );
  return Promise.allSettled(promises);
};