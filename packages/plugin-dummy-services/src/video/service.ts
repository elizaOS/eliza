import { IAgentRuntime, Service, ServiceType, logger } from '@elizaos/core';

// Define video-specific types locally since they're not in core
export interface VideoInfo {
  title: string;
  duration: number;
  resolution: {
    width: number;
    height: number;
  };
  format: string;
  size: number;
  fps: number;
  codec: string;
}

export interface VideoFormat {
  format: string;
  resolution: string;
  size: number;
  url?: string;
}

export interface VideoDownloadOptions {
  format?: string;
  quality?: 'highest' | 'lowest' | 'medium';
  audioOnly?: boolean;
}

export interface VideoProcessingOptions {
  startTime?: number;
  endTime?: number;
  outputFormat?: string;
  resolution?: string;
  fps?: number;
}

/**
 * Dummy video service for testing purposes
 * Provides mock implementations of video operations
 */
export class DummyVideoService extends Service {
  static readonly serviceType = ServiceType.VIDEO;

  capabilityDescription = 'Dummy video service for testing';

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<DummyVideoService> {
    const service = new DummyVideoService(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    logger.info('DummyVideoService initialized');
  }

  async stop(): Promise<void> {
    logger.info('DummyVideoService stopped');
  }

  async getVideoInfo(url: string): Promise<VideoInfo> {
    logger.debug(`Getting video info for: ${url}`);

    return {
      title: 'Dummy Video Title',
      duration: 300, // 5 minutes
      resolution: {
        width: 1920,
        height: 1080,
      },
      format: 'mp4',
      size: 50000000, // 50MB
      fps: 30,
      codec: 'h264',
    };
  }

  async downloadVideo(url: string, options?: VideoDownloadOptions): Promise<Buffer> {
    logger.debug(`Downloading video from: ${url}`, JSON.stringify(options));

    // Return dummy video buffer
    const dummyVideo = Buffer.from(`dummy-video-${options?.format || 'mp4'}`);

    logger.debug(`Downloaded video: ${dummyVideo.length} bytes`);

    return dummyVideo;
  }

  async extractAudio(videoBuffer: Buffer): Promise<Buffer> {
    logger.debug(`Extracting audio from video (${videoBuffer.length} bytes)`);

    // Return dummy audio buffer
    return Buffer.from('dummy-audio-from-video');
  }

  async extractFrames(videoBuffer: Buffer, timestamps: number[]): Promise<Buffer[]> {
    logger.debug(`Extracting ${timestamps.length} frames from video`);

    // Return dummy frame buffers
    return timestamps.map((ts, index) => Buffer.from(`dummy-frame-${index}-at-${ts}s`));
  }

  async processVideo(videoBuffer: Buffer, options: VideoProcessingOptions): Promise<Buffer> {
    logger.debug('Processing video', JSON.stringify(options));

    // Return dummy processed video buffer
    const processedVideo = Buffer.from(`dummy-processed-video-${options.outputFormat || 'mp4'}`);

    logger.debug(`Processed video: ${processedVideo.length} bytes`);

    return processedVideo;
  }

  async getAvailableFormats(url: string): Promise<VideoFormat[]> {
    logger.debug(`Getting available formats for: ${url}`);

    return [
      {
        format: 'mp4',
        resolution: '1920x1080',
        size: 50000000,
        url: `${url}?format=1080p`,
      },
      {
        format: 'mp4',
        resolution: '1280x720',
        size: 25000000,
        url: `${url}?format=720p`,
      },
      {
        format: 'mp4',
        resolution: '640x480',
        size: 10000000,
        url: `${url}?format=480p`,
      },
    ];
  }

  getDexName(): string {
    return 'dummy-video';
  }
}
