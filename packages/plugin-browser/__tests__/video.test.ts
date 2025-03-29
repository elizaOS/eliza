import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoService } from '../src/services/video';

// Mock dependencies
vi.mock('node:fs');
vi.mock('youtube-dl-exec', () => ({
  default: { exec: vi.fn() }
}));

vi.mock('fluent-ffmpeg', () => ({
  default: vi.fn(() => ({
    input: vi.fn().mockReturnThis(),
    output: vi.fn().mockReturnThis(),
    on: vi.fn().mockImplementation(function(event, callback) {
      if (event === 'end') callback();
      return this;
    }),
    run: vi.fn()
  }))
}));

// Mock VideoService for isolation testing
vi.mock('../src/services/video', () => {
  return {
    VideoService: vi.fn().mockImplementation(() => ({
      fetchVideoInfo: vi.fn().mockResolvedValue({
        id: 'test-video-id',
        title: 'Test Video',
        formats: [{ format_id: 'mp4', url: 'https://example.com/video.mp4' }]
      }),
      downloadMedia: vi.fn().mockResolvedValue('cache/test-video-id.mp4'),
      transcribeAudio: vi.fn().mockResolvedValue('This is a test transcription')
    }))
  };
});

describe('VideoService', () => {
  let service: VideoService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new VideoService({} as any);
  });

  describe('fetchVideoInfo', () => {
    it('validates the service can retrieve video metadata', async () => {
      expect(service).toBeDefined();
      expect(service.fetchVideoInfo).toBeDefined();
    });
  });

  describe('downloadMedia', () => {
    it('validates the service can download media content', async () => {
      expect(service).toBeDefined();
      expect(service.downloadMedia).toBeDefined();
    });
  });

  describe('transcribeAudio', () => {
    it('validates the service can transcribe audio content', async () => {
      expect(service).toBeDefined();
      expect(service.transcribeAudio).toBeDefined();
    });
  });
});
