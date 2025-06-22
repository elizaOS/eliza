import { describe, beforeEach, afterEach, it, expect, jest, mock } from 'bun:test';
import type { MockedFunction } from 'bun:test';
import { MediaService } from '../../services/media';
import type { ApiClient } from '../../client';
import type {
  MediaUploadOptions,
  MediaMetadata,
  MediaResponse,
  MediaListResponse,
  MediaListOptions,
  MediaUpdateData,
  MediaStats
} from '../../types/media';

const mockApiClient = {
  post: mock(() => Promise.resolve()),
  get: mock(() => Promise.resolve()),
  put: mock(() => Promise.resolve()),
  delete: mock(() => Promise.resolve()),
  upload: mock(() => Promise.resolve()),
} as unknown as jest.Mocked<ApiClient>;

const mockMediaMetadata: MediaMetadata = {
  id: 'media-123',
  filename: 'test-image.jpg',
  mimetype: 'image/jpeg',
  size: 1024000,
  url: 'https://cdn.example.com/media/test-image.jpg',
  thumbnail: 'https://cdn.example.com/media/thumbs/test-image.jpg',
  uploadedAt: '2023-01-01T12:00:00Z',
  updatedAt: '2023-01-01T12:00:00Z',
  tags: ['image', 'test'],
  description: 'Test image for unit testing',
  userId: 'user-456',
  checksum: 'sha256:abcd1234...'
};

const createMockFile = (name: string, type: string, size: number = 1024): File => {
  const content = 'x'.repeat(size);
  return new File([content], name, { type });
};

const mockUploadOptions: MediaUploadOptions = {
  file: createMockFile('test-image.jpg', 'image/jpeg'),
  metadata: {
    tags: ['test', 'unit-test'],
    description: 'Test image upload via unit test'
  },
  generateThumbnail: true,
  public: false
};

describe('MediaService', () => {
  let mediaService: MediaService;

  beforeEach(() => {
    mockApiClient.post.mockReset();
    mockApiClient.get.mockReset();
    mockApiClient.put.mockReset();
    mockApiClient.delete.mockReset();
    mockApiClient.upload.mockReset();
    mediaService = new MediaService(mockApiClient);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('uploadMedia', () => {
    const successResponse: MediaResponse = {
      success: true,
      data: mockMediaMetadata
    };

    it('should successfully upload media with valid options', async () => {
      mockApiClient.upload.mockResolvedValue(successResponse);
      const result = await mediaService.uploadMedia(mockUploadOptions);
      expect(mockApiClient.upload).toHaveBeenCalledWith('/api/media/upload', {
        file: mockUploadOptions.file,
        metadata: mockUploadOptions.metadata,
        generateThumbnail: true,
        public: false
      });
      expect(result).toEqual(successResponse);
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject(mockMediaMetadata);
    });

    it('should upload with minimal options', async () => {
      const minimalOptions = { file: createMockFile('simple.jpg', 'image/jpeg') };
      mockApiClient.upload.mockResolvedValue(successResponse);
      const result = await mediaService.uploadMedia(minimalOptions);
      expect(mockApiClient.upload).toHaveBeenCalledWith('/api/media/upload', {
        file: minimalOptions.file,
        metadata: {},
        generateThumbnail: false,
        public: true
      });
      expect(result.success).toBe(true);
    });

    it('should handle upload failure with error message', async () => {
      const errorResponse: MediaResponse = {
        success: false,
        error: 'Upload failed: File size exceeds limit',
        code: 'FILE_TOO_LARGE'
      };
      mockApiClient.upload.mockResolvedValue(errorResponse);
      const result = await mediaService.uploadMedia(mockUploadOptions);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Upload failed: File size exceeds limit');
      expect(result.code).toBe('FILE_TOO_LARGE');
    });

    it('should validate file presence', async () => {
      const invalidOptions = { ...mockUploadOptions, file: undefined as any };
      await expect(mediaService.uploadMedia(invalidOptions))
        .rejects.toThrow('File is required for media upload');
    });

    it('should validate file size limits', async () => {
      const largeFile = createMockFile('large.jpg', 'image/jpeg', 100 * 1024 * 1024);
      const largeFileOptions = { ...mockUploadOptions, file: largeFile };
      await expect(mediaService.uploadMedia(largeFileOptions))
        .rejects.toThrow('File size exceeds maximum allowed limit of 50MB');
    });

    it('should validate supported file types', async () => {
      const unsupportedFile = createMockFile('malware.exe', 'application/x-executable');
      const unsupportedOptions = { ...mockUploadOptions, file: unsupportedFile };
      await expect(mediaService.uploadMedia(unsupportedOptions))
        .rejects.toThrow('File type application/x-executable is not supported');
    });

    it('should handle network errors during upload', async () => {
      mockApiClient.upload.mockRejectedValue(new Error('Network connection failed'));
      await expect(mediaService.uploadMedia(mockUploadOptions))
        .rejects.toThrow('Network connection failed');
    });

    it('should handle server errors during upload', async () => {
      mockApiClient.upload.mockRejectedValue(new Error('Internal Server Error'));
      await expect(mediaService.uploadMedia(mockUploadOptions))
        .rejects.toThrow('Internal Server Error');
    });
  });

  describe('getMedia', () => {
    const successResponse: MediaResponse = {
      success: true,
      data: mockMediaMetadata
    };

    it('should successfully retrieve media by ID', async () => {
      mockApiClient.get.mockResolvedValue(successResponse);
      const result = await mediaService.getMedia('media-123');
      expect(mockApiClient.get).toHaveBeenCalledWith('/api/media/media-123');
      expect(result).toEqual(successResponse);
      expect(result.data?.id).toBe('media-123');
    });

    it('should retrieve media with additional options', async () => {
      mockApiClient.get.mockResolvedValue(successResponse);
      const result = await mediaService.getMedia('media-123', {
        includeThumbnail: true,
        includeStats: true
      });
      expect(mockApiClient.get).toHaveBeenCalledWith('/api/media/media-123', {
        params: { includeThumbnail: true, includeStats: true }
      });
      expect(result.success).toBe(true);
    });

    it('should handle media not found', async () => {
      const notFoundResponse: MediaResponse = {
        success: false,
        error: 'Media not found',
        code: 'MEDIA_NOT_FOUND'
      };
      mockApiClient.get.mockResolvedValue(notFoundResponse);
      const result = await mediaService.getMedia('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Media not found');
      expect(result.code).toBe('MEDIA_NOT_FOUND');
    });

    it('should validate media ID format', async () => {
      await expect(mediaService.getMedia(''))
        .rejects.toThrow('Media ID cannot be empty');
      await expect(mediaService.getMedia(null as any))
        .rejects.toThrow('Media ID is required');
      await expect(mediaService.getMedia('invalid-id-format!@#'))
        .rejects.toThrow('Invalid media ID format');
    });

    it('should handle authorization errors', async () => {
      mockApiClient.get.mockRejectedValue(new Error('Unauthorized: Access denied'));
      await expect(mediaService.getMedia('media-123'))
        .rejects.toThrow('Unauthorized: Access denied');
    });
  });

  describe('listMedia', () => {
    const mockMediaList: MediaListResponse = {
      success: true,
      data: {
        items: [mockMediaMetadata],
        total: 100,
        page: 1,
        limit: 10,
        hasNext: true,
        hasPrev: false
      }
    };

    it('should retrieve paginated media list with default options', async () => {
      mockApiClient.get.mockResolvedValue(mockMediaList);
      const result = await mediaService.listMedia();
      expect(mockApiClient.get).toHaveBeenCalledWith('/api/media', {
        params: { page: 1, limit: 20 }
      });
      expect(result.data.items).toHaveLength(1);
      expect(result.data.total).toBe(100);
    });

    it('should apply custom pagination options', async () => {
      const options: MediaListOptions = { page: 3, limit: 50 };
      mockApiClient.get.mockResolvedValue(mockMediaList);
      await mediaService.listMedia(options);
      expect(mockApiClient.get).toHaveBeenCalledWith('/api/media', {
        params: { page: 3, limit: 50 }
      });
    });

    it('should apply filtering options', async () => {
      const filters: MediaListOptions = {
        page: 1,
        limit: 10,
        tags: ['image', 'test'],
        mimetype: 'image/jpeg',
        dateFrom: '2023-01-01',
        dateTo: '2023-12-31',
        userId: 'user-456',
        searchTerm: 'test image'
      };
      mockApiClient.get.mockResolvedValue(mockMediaList);
      await mediaService.listMedia(filters);
      expect(mockApiClient.get).toHaveBeenCalledWith('/api/media', {
        params: filters
      });
    });

    it('should handle empty media list', async () => {
      const emptyResponse: MediaListResponse = {
        success: true,
        data: {
          items: [],
          total: 0,
          page: 1,
          limit: 20,
          hasNext: false,
          hasPrev: false
        }
      };
      mockApiClient.get.mockResolvedValue(emptyResponse);
      const result = await mediaService.listMedia();
      expect(result.data.items).toHaveLength(0);
      expect(result.data.total).toBe(0);
    });

    it('should validate pagination parameters', async () => {
      await expect(mediaService.listMedia({ page: 0, limit: 10 }))
        .rejects.toThrow('Page number must be greater than 0');
      await expect(mediaService.listMedia({ page: 1, limit: 0 }))
        .rejects.toThrow('Limit must be between 1 and 100');
      await expect(mediaService.listMedia({ page: 1, limit: 101 }))
        .rejects.toThrow('Limit must be between 1 and 100');
    });
  });

  describe('updateMedia', () => {
    const updateData: MediaUpdateData = {
      tags: ['updated', 'image', 'test'],
      description: 'Updated test image description',
      public: true
    };
    const updatedMediaMetadata = { ...mockMediaMetadata, ...updateData };
    const successResponse: MediaResponse = {
      success: true,
      data: updatedMediaMetadata
    };

    it('should successfully update media metadata', async () => {
      mockApiClient.put.mockResolvedValue(successResponse);
      const result = await mediaService.updateMedia('media-123', updateData);
      expect(mockApiClient.put).toHaveBeenCalledWith('/api/media/media-123', updateData);
      expect(result.success).toBe(true);
      expect(result.data?.tags).toEqual(['updated', 'image', 'test']);
      expect(result.data?.description).toBe('Updated test image description');
    });

    it('should update partial metadata', async () => {
      const partialUpdate = { description: 'New description only' };
      const partialResponse = {
        success: true,
        data: { ...mockMediaMetadata, description: 'New description only' }
      };
      mockApiClient.put.mockResolvedValue(partialResponse);
      const result = await mediaService.updateMedia('media-123', partialUpdate);
      expect(mockApiClient.put).toHaveBeenCalledWith('/api/media/media-123', partialUpdate);
      expect(result.data?.description).toBe('New description only');
    });

    it('should handle update validation errors', async () => {
      const invalidUpdate = { tags: 'invalid-tags-format' as any };
      await expect(mediaService.updateMedia('media-123', invalidUpdate))
        .rejects.toThrow('Tags must be an array of strings');
    });

    it('should handle media not found during update', async () => {
      const notFoundResponse: MediaResponse = {
        success: false,
        error: 'Media not found',
        code: 'MEDIA_NOT_FOUND'
      };
      mockApiClient.put.mockResolvedValue(notFoundResponse);
      const result = await mediaService.updateMedia('nonexistent', updateData);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Media not found');
    });

    it('should validate media ID for updates', async () => {
      await expect(mediaService.updateMedia('', updateData))
        .rejects.toThrow('Media ID cannot be empty');
      await expect(mediaService.updateMedia(null as any, updateData))
        .rejects.toThrow('Media ID is required');
    });
  });

  describe('deleteMedia', () => {
    const deleteResponse = {
      success: true,
      message: 'Media deleted successfully'
    };

    it('should successfully delete media', async () => {
      mockApiClient.delete.mockResolvedValue(deleteResponse);
      const result = await mediaService.deleteMedia('media-123');
      expect(mockApiClient.delete).toHaveBeenCalledWith('/api/media/media-123');
      expect(result.success).toBe(true);
      expect(result.message).toBe('Media deleted successfully');
    });

    it('should handle permanent deletion', async () => {
      mockApiClient.delete.mockResolvedValue(deleteResponse);
      const result = await mediaService.deleteMedia('media-123', { permanent: true });
      expect(mockApiClient.delete).toHaveBeenCalledWith('/api/media/media-123', {
        params: { permanent: true }
      });
      expect(result.success).toBe(true);
    });

    it('should handle deletion of non-existent media', async () => {
      const notFoundResponse = {
        success: false,
        error: 'Media not found',
        code: 'MEDIA_NOT_FOUND'
      };
      mockApiClient.delete.mockResolvedValue(notFoundResponse);
      const result = await mediaService.deleteMedia('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Media not found');
    });

    it('should handle permission errors during deletion', async () => {
      mockApiClient.delete.mockRejectedValue(new Error('Forbidden: Insufficient permissions'));
      await expect(mediaService.deleteMedia('media-123'))
        .rejects.toThrow('Forbidden: Insufficient permissions');
    });

    it('should validate media ID for deletion', async () => {
      await expect(mediaService.deleteMedia(''))
        .rejects.toThrow('Media ID cannot be empty');
    });
  });

  describe('generateThumbnail', () => {
    const thumbnailResponse = {
      success: true,
      data: {
        thumbnailUrl: 'https://cdn.example.com/thumbs/media-123.jpg',
        sizes: ['small', 'medium', 'large']
      }
    };

    it('should generate thumbnail for supported media', async () => {
      mockApiClient.post.mockResolvedValue(thumbnailResponse);
      const result = await mediaService.generateThumbnail('media-123');
      expect(mockApiClient.post).toHaveBeenCalledWith('/api/media/media-123/thumbnail');
      expect(result.success).toBe(true);
      expect(result.data?.thumbnailUrl).toBe('https://cdn.example.com/thumbs/media-123.jpg');
    });

    it('should generate thumbnail with custom options', async () => {
      const options = { size: 'large', quality: 80 };
      mockApiClient.post.mockResolvedValue(thumbnailResponse);
      await mediaService.generateThumbnail('media-123', options);
      expect(mockApiClient.post).toHaveBeenCalledWith('/api/media/media-123/thumbnail', options);
    });

    it('should handle thumbnail generation for unsupported formats', async () => {
      const unsupportedResponse = {
        success: false,
        error: 'Thumbnail generation not supported for this file type',
        code: 'UNSUPPORTED_FORMAT'
      };
      mockApiClient.post.mockResolvedValue(unsupportedResponse);
      const result = await mediaService.generateThumbnail('media-123');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not supported');
    });
  });

  describe('getMediaStats', () => {
    const statsResponse = {
      success: true,
      data: {
        totalFiles: 1500,
        totalSize: 10737418240,
        averageSize: 7158278,
        fileTypes: {
          'image/jpeg': 800,
          'image/png': 500,
          'video/mp4': 100,
          'application/pdf': 100
        },
        uploadTrends: {
          daily: [10, 15, 8, 20, 12],
          monthly: [300, 250, 400, 350]
        }
      }
    } as { success: boolean; data: MediaStats };

    it('should retrieve comprehensive media statistics', async () => {
      mockApiClient.get.mockResolvedValue(statsResponse);
      const result = await mediaService.getMediaStats();
      expect(mockApiClient.get).toHaveBeenCalledWith('/api/media/stats');
      expect(result.success).toBe(true);
      expect(result.data.totalFiles).toBe(1500);
      expect(result.data.totalSize).toBe(10737418240);
      expect(result.data.fileTypes['image/jpeg']).toBe(800);
    });

    it('should retrieve filtered statistics', async () => {
      const filters = {
        dateFrom: '2023-01-01',
        dateTo: '2023-12-31',
        userId: 'user-456'
      };
      mockApiClient.get.mockResolvedValue(statsResponse);
      await mediaService.getMediaStats(filters);
      expect(mockApiClient.get).toHaveBeenCalledWith('/api/media/stats', {
        params: filters
      });
    });
  });

  describe('searchMedia', () => {
    const searchResponse: MediaListResponse = {
      success: true,
      data: {
        items: [mockMediaMetadata],
        total: 1,
        page: 1,
        limit: 20,
        hasNext: false,
        hasPrev: false,
        searchTerm: 'test image'
      }
    };

    it('should search media with text query', async () => {
      mockApiClient.get.mockResolvedValue(searchResponse);
      const result = await mediaService.searchMedia('test image');
      expect(mockApiClient.get).toHaveBeenCalledWith('/api/media/search', {
        params: {
          q: 'test image',
          page: 1,
          limit: 20
        }
      });
      expect(result.data.items).toHaveLength(1);
    });

    it('should search with advanced filters', async () => {
      const filters = {
        tags: ['image'],
        mimetype: 'image/jpeg',
        minSize: 1000,
        maxSize: 5000000
      };
      mockApiClient.get.mockResolvedValue(searchResponse);
      await mediaService.searchMedia('test', filters);
      expect(mockApiClient.get).toHaveBeenCalledWith('/api/media/search', {
        params: {
          q: 'test',
          page: 1,
          limit: 20,
          ...filters
        }
      });
    });
  });

  describe('error handling and edge cases', () => {
    it('should handle rate limiting', async () => {
      const rateLimitError = new Error('Too Many Requests');
      (rateLimitError as any).status = 429;
      mockApiClient.get.mockRejectedValue(rateLimitError);
      await expect(mediaService.getMedia('media-123'))
        .rejects.toThrow('Too Many Requests');
    });

    it('should handle network connectivity issues', async () => {
      mockApiClient.get.mockRejectedValue(new Error('Network Error: Connection timeout'));
      await expect(mediaService.listMedia())
        .rejects.toThrow('Network Error: Connection timeout');
    });

    it('should handle malformed API responses', async () => {
      mockApiClient.get.mockResolvedValue({ invalid: 'response' });
      await expect(mediaService.getMedia('media-123'))
        .rejects.toThrow('Invalid API response format');
    });
  });
});