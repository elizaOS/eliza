import { IAgentRuntime } from '@elizaos/core';
import {
  IVideoService,
  VideoInfo,
  VideoFormat,
  VideoDownloadOptions,
  VideoProcessingOptions,
} from '@elizaos/core';

/**
 * Dummy video service for testing purposes
 * Provides mock implementations of video processing operations
 */
export class DummyVideoService extends IVideoService {
  static override readonly serviceType = IVideoService.serviceType;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<DummyVideoService> {
    const service = new DummyVideoService(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    this.runtime.logger.info('DummyVideoService initialized');
  }

  async stop(): Promise<void> {
    this.runtime.logger.info('DummyVideoService stopped');
  }

  async getVideoInfo(url: string): Promise<VideoInfo> {
    this.runtime.logger.debug(`Getting video info for ${url}`);

    return {
      title: 'Mock Video Title',
      duration: 300, // 5 minutes in seconds
      url,
      thumbnail: 'https://example.com/thumbnail.jpg',
      description: 'This is a mock video description for testing purposes.',
      uploader: 'DummyUploader',
      viewCount: 12345,
      uploadDate: new Date('2024-01-01'),
      formats: [
        {
          formatId: 'mp4-720p',
          url: 'https://example.com/video-720p.mp4',
          extension: 'mp4',
          quality: '720p',
          fileSize: 50000000, // 50MB
          videoCodec: 'h264',
          audioCodec: 'aac',
          resolution: '1280x720',
          fps: 30,
          bitrate: 1000000,
        },
        {
          formatId: 'mp4-1080p',
          url: 'https://example.com/video-1080p.mp4',
          extension: 'mp4',
          quality: '1080p',
          fileSize: 100000000, // 100MB
          videoCodec: 'h264',
          audioCodec: 'aac',
          resolution: '1920x1080',
          fps: 30,
          bitrate: 2000000,
        },
      ],
    };
  }

  async downloadVideo(url: string, options?: VideoDownloadOptions): Promise<string> {
    this.runtime.logger.debug(`Downloading video from ${url}`);

    if (options) {
      this.runtime.logger.debug('Download options:', options);
    }

    // Mock download - return a fake file path
    const filename = `mock-video-${Date.now()}.mp4`;
    const outputPath = options?.outputPath || `/tmp/${filename}`;

    // Simulate some download processing
    await new Promise((resolve) => setTimeout(resolve, 100));

    return outputPath;
  }

  async extractAudio(videoPath: string, outputPath?: string): Promise<string> {
    this.runtime.logger.debug(`Extracting audio from ${videoPath}`);

    const audioPath = outputPath || videoPath.replace(/\.[^/.]+$/, '') + '.mp3';

    // Simulate audio extraction
    await new Promise((resolve) => setTimeout(resolve, 50));

    return audioPath;
  }

  async getThumbnail(videoPath: string, timestamp?: number): Promise<string> {
    this.runtime.logger.debug(`Generating thumbnail for ${videoPath} at ${timestamp || 0}s`);

    const thumbnailPath = videoPath.replace(/\.[^/.]+$/, '') + `_${timestamp || 0}s.jpg`;

    // Simulate thumbnail generation
    await new Promise((resolve) => setTimeout(resolve, 30));

    return thumbnailPath;
  }

  async convertVideo(
    videoPath: string,
    outputPath: string,
    options?: VideoProcessingOptions
  ): Promise<string> {
    this.runtime.logger.debug(`Converting video from ${videoPath} to ${outputPath}`);

    if (options) {
      this.runtime.logger.debug('Conversion options:', options);
    }

    // Simulate video conversion
    await new Promise((resolve) => setTimeout(resolve, 200));

    return outputPath;
  }

  async getAvailableFormats(url: string): Promise<VideoFormat[]> {
    this.runtime.logger.debug(`Getting available formats for ${url}`);

    return [
      {
        formatId: 'mp4-360p',
        url: 'https://example.com/video-360p.mp4',
        extension: 'mp4',
        quality: '360p',
        fileSize: 15000000, // 15MB
        videoCodec: 'h264',
        audioCodec: 'aac',
        resolution: '640x360',
        fps: 30,
        bitrate: 500000,
      },
      {
        formatId: 'mp4-720p',
        url: 'https://example.com/video-720p.mp4',
        extension: 'mp4',
        quality: '720p',
        fileSize: 50000000, // 50MB
        videoCodec: 'h264',
        audioCodec: 'aac',
        resolution: '1280x720',
        fps: 30,
        bitrate: 1000000,
      },
      {
        formatId: 'mp4-1080p',
        url: 'https://example.com/video-1080p.mp4',
        extension: 'mp4',
        quality: '1080p',
        fileSize: 100000000, // 100MB
        videoCodec: 'h264',
        audioCodec: 'aac',
        resolution: '1920x1080',
        fps: 30,
        bitrate: 2000000,
      },
      {
        formatId: 'audio-only',
        url: 'https://example.com/audio.mp3',
        extension: 'mp3',
        quality: 'audio',
        fileSize: 5000000, // 5MB
        audioCodec: 'mp3',
        bitrate: 128000,
      },
    ];
  }
}
