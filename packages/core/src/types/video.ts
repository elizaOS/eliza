import { Service, ServiceType } from './service';

export interface VideoInfo {
  title?: string;
  duration?: number;
  url: string;
  thumbnail?: string;
  description?: string;
  uploader?: string;
  viewCount?: number;
  uploadDate?: Date;
  formats?: VideoFormat[];
}

export interface VideoFormat {
  formatId: string;
  url: string;
  extension: string;
  quality: string;
  fileSize?: number;
  videoCodec?: string;
  audioCodec?: string;
  resolution?: string;
  fps?: number;
  bitrate?: number;
}

export interface VideoDownloadOptions {
  format?: string;
  quality?: 'best' | 'worst' | 'bestvideo' | 'bestaudio' | string;
  outputPath?: string;
  audioOnly?: boolean;
  videoOnly?: boolean;
  subtitles?: boolean;
  embedSubs?: boolean;
  writeInfoJson?: boolean;
}

export interface VideoProcessingOptions {
  startTime?: number;
  endTime?: number;
  outputFormat?: string;
  resolution?: string;
  bitrate?: string;
  framerate?: number;
  audioCodec?: string;
  videoCodec?: string;
}

/**
 * Interface for video processing and download services
 */
export abstract class IVideoService extends Service {
  static override readonly serviceType = ServiceType.VIDEO;

  public readonly capabilityDescription = 'Video download, processing, and conversion capabilities';

  /**
   * Get video information without downloading
   * @param url - Video URL
   * @returns Promise resolving to video information
   */
  abstract getVideoInfo(url: string): Promise<VideoInfo>;

  /**
   * Download a video from URL
   * @param url - Video URL
   * @param options - Download options
   * @returns Promise resolving to downloaded file path
   */
  abstract downloadVideo(url: string, options?: VideoDownloadOptions): Promise<string>;

  /**
   * Extract audio from video
   * @param videoPath - Path to video file or video URL
   * @param outputPath - Optional output path for audio file
   * @returns Promise resolving to audio file path
   */
  abstract extractAudio(videoPath: string, outputPath?: string): Promise<string>;

  /**
   * Generate thumbnail from video
   * @param videoPath - Path to video file or video URL
   * @param timestamp - Timestamp in seconds to capture thumbnail
   * @returns Promise resolving to thumbnail image path
   */
  abstract getThumbnail(videoPath: string, timestamp?: number): Promise<string>;

  /**
   * Convert video to different format
   * @param videoPath - Path to input video file
   * @param outputPath - Path for output video file
   * @param options - Processing options
   * @returns Promise resolving to converted video path
   */
  abstract convertVideo(
    videoPath: string,
    outputPath: string,
    options?: VideoProcessingOptions
  ): Promise<string>;

  /**
   * Get available formats for a video URL
   * @param url - Video URL
   * @returns Promise resolving to available formats
   */
  abstract getAvailableFormats(url: string): Promise<VideoFormat[]>;
}
