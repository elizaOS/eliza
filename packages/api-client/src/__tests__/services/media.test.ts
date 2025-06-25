import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { MediaService } from '../../services/media';
import { ApiClientConfig } from '../../types/base';
import { UUID } from '@elizaos/core';

// Test UUIDs in proper format
const TEST_AGENT_ID = '550e8400-e29b-41d4-a716-446655440001' as UUID;
const TEST_CHANNEL_ID = '550e8400-e29b-41d4-a716-446655440002' as UUID;

describe('MediaService', () => {
  let mediaService: MediaService;
  const mockConfig: ApiClientConfig = {
    baseUrl: 'http://localhost:3000',
    apiKey: 'test-key',
  };

  beforeEach(() => {
    mediaService = new MediaService(mockConfig);
    // Mock the HTTP methods
    (mediaService as any).request = mock(() => Promise.resolve({}));
  });

  afterEach(() => {
    const requestMock = (mediaService as any).request;
    if (requestMock?.mockClear) requestMock.mockClear();
  });

  describe('constructor', () => {
    it('should create an instance with valid configuration', () => {
      expect(mediaService).toBeInstanceOf(MediaService);
    });

    it('should throw error when initialized with invalid configuration', () => {
      expect(() => new MediaService(null as any)).toThrow();
    });
  });

  describe('uploadAgentMedia', () => {
    const mockFile = new Blob(['test content'], { type: 'image/png' });
    const params = {
      file: mockFile,
      filename: 'test.png',
      contentType: 'image/png',
      metadata: { description: 'Test image' },
    };

    it('should upload agent media successfully', async () => {
      const mockResponse = {
        id: '550e8400-e29b-41d4-a716-446655440010' as UUID,
        url: 'http://example.com/media/test.png',
        filename: 'test.png',
        contentType: 'image/png',
        size: 1024,
        uploadedAt: new Date('2024-01-01T00:00:00Z'),
        metadata: { description: 'Test image' },
      };
      (mediaService as any).request.mockResolvedValue(mockResponse);

      const result = await mediaService.uploadAgentMedia(TEST_AGENT_ID, params);

      expect((mediaService as any).request).toHaveBeenCalledWith(
        'POST',
        `/api/media/agents/${TEST_AGENT_ID}/upload-media`,
        expect.objectContaining({
          body: expect.any(FormData),
        })
      );
      expect(result).toEqual(mockResponse);
    });

    it('should handle file upload without optional parameters', async () => {
      const paramsMinimal = { file: mockFile };
      const mockResponse = {
        id: '550e8400-e29b-41d4-a716-446655440011' as UUID,
        url: 'http://example.com/media/test.png',
        filename: 'test.png',
        contentType: 'image/png',
        size: 512,
        uploadedAt: new Date('2024-01-01T00:00:00Z'),
      };
      (mediaService as any).request.mockResolvedValue(mockResponse);

      await mediaService.uploadAgentMedia(TEST_AGENT_ID, paramsMinimal);

      expect((mediaService as any).request).toHaveBeenCalled();
    });
  });

  describe('uploadChannelMedia', () => {
    const mockFile = new File(['test content'], 'test.png', { type: 'image/png' });

    it('should upload channel media successfully', async () => {
      const mockResponse = {
        id: '550e8400-e29b-41d4-a716-446655440020' as UUID,
        url: 'http://example.com/media/test.png',
        filename: 'test.png',
        size: 1024,
        contentType: 'image/png',
        uploadedAt: new Date('2024-01-01T00:00:00Z'),
      };
      (mediaService as any).request.mockResolvedValue(mockResponse);

      const result = await mediaService.uploadChannelMedia(TEST_CHANNEL_ID, mockFile);

      expect((mediaService as any).request).toHaveBeenCalledWith(
        'POST',
        `/api/messaging/central-channels/${TEST_CHANNEL_ID}/upload-media`,
        expect.objectContaining({
          body: expect.any(FormData),
        })
      );
      expect(result).toEqual(mockResponse);
    });

    it('should handle file upload without errors', async () => {
      const mockResponse = {
        id: '550e8400-e29b-41d4-a716-446655440020' as UUID,
        url: 'http://example.com/media/test.png',
        filename: 'test.png',
        size: 1024,
        contentType: 'image/png',
        uploadedAt: new Date('2024-01-01T00:00:00Z'),
      };
      (mediaService as any).request.mockResolvedValue(mockResponse);

      await mediaService.uploadChannelMedia(TEST_CHANNEL_ID, mockFile);

      expect((mediaService as any).request).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    const mockFile = new Blob(['test'], { type: 'image/png' });

    it('should handle network errors', async () => {
      (mediaService as any).request.mockRejectedValue(new Error('Network error'));

      await expect(
        mediaService.uploadAgentMedia(TEST_AGENT_ID, { file: mockFile, filename: 'test.png' })
      ).rejects.toThrow('Network error');
    });

    it('should handle file upload errors', async () => {
      (mediaService as any).request.mockRejectedValue(new Error('Upload failed'));

      await expect(mediaService.uploadChannelMedia(TEST_CHANNEL_ID, mockFile)).rejects.toThrow(
        'Upload failed'
      );
    });

    it('should handle API errors', async () => {
      (mediaService as any).request.mockRejectedValue(new Error('API error'));

      await expect(
        mediaService.uploadAgentMedia(TEST_AGENT_ID, { file: mockFile, filename: 'test.png' })
      ).rejects.toThrow('API error');
    });
  });
});
