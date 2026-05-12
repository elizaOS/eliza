import {
  elizaLogger,
  type IAgentRuntime,
  type ITranscriptionService,
  IVideoService,
  type Media,
  type Service,
  ServiceType,
  stringToUuid,
  type VideoDownloadOptions,
  type VideoFormat,
  type VideoInfo,
  type VideoProcessingOptions,
} from "@elizaos/core";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import { tmpdir } from "os";
import path from "path";
import { BinaryResolver } from "./binaries";

/** Minimal yt-dlp JSON shape used by this service (fields vary by extractor). */
interface YtDlpSubtitleTrack {
  url: string;
}

interface YtDlpJson {
  title?: string;
  description?: string;
  channel?: string;
  duration?: number;
  thumbnail?: string;
  view_count?: number;
  upload_date?: string;
  formats?: YtDlpFormatRow[];
  categories?: string[];
  subtitles?: Record<string, YtDlpSubtitleTrack[]>;
  automatic_captions?: Record<string, YtDlpSubtitleTrack[]>;
}

interface YtDlpFormatRow {
  format_id?: string;
  url?: string;
  ext?: string;
  quality?: string | number;
  filesize?: number;
  vcodec?: string;
  acodec?: string;
  resolution?: string;
  fps?: number;
  tbr?: number;
}

export class VideoService extends IVideoService {
  public readonly capabilityDescription =
    "Video download, processing, and conversion capabilities";
  static override readonly serviceType = ServiceType.VIDEO;
  private cacheKey = "content/video";
  private dataDir = "./content_cache";
  private readonly binaries: BinaryResolver;
  private ffmpegPathConfigured = false;

  /** Serialize downloads/processing so cache keys and temp files do not race. */
  private processingChain: Promise<void> = Promise.resolve();

  constructor(runtime?: IAgentRuntime, binaries?: BinaryResolver) {
    super(runtime);
    this.binaries = binaries ?? BinaryResolver.instance();
    this.ensureDataDirectoryExists();
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new VideoService(runtime);
    await service.initialize(runtime);
    return service;
  }

  async initialize(_runtime: IAgentRuntime): Promise<void> {
    await this.configureFfmpeg();
  }

  private async configureFfmpeg(): Promise<void> {
    if (this.ffmpegPathConfigured) return;
    const ffmpegPath = await this.binaries.getFfmpegPath();
    if (ffmpegPath) {
      ffmpeg.setFfmpegPath(ffmpegPath);
      elizaLogger.log(`[plugin-video] ffmpeg path: ${ffmpegPath}`);
    } else {
      elizaLogger.warn(
        "[plugin-video] No ffmpeg binary located via env, PATH, or ffmpeg-static; fluent-ffmpeg will fail at first invocation.",
      );
    }
    this.ffmpegPathConfigured = true;
  }

  async stop(): Promise<void> {
    this.processingChain = Promise.resolve();
  }

  // Required abstract methods from IVideoService
  async getVideoInfo(url: string): Promise<VideoInfo> {
    const videoInfo = await this.fetchVideoInfo(url);
    const formats: VideoFormat[] = (videoInfo.formats ?? []).map(
      (f: YtDlpFormatRow) => ({
        formatId: f.format_id ?? "",
        url: f.url ?? "",
        extension: f.ext ?? "",
        quality:
          f.quality !== undefined && f.quality !== ""
            ? String(f.quality)
            : "unknown",
        fileSize: f.filesize,
        videoCodec: f.vcodec,
        audioCodec: f.acodec,
        resolution: f.resolution,
        fps: f.fps,
        bitrate: f.tbr,
      }),
    );
    return {
      title: videoInfo.title,
      duration: videoInfo.duration,
      url: url,
      thumbnail: videoInfo.thumbnail,
      description: videoInfo.description,
      uploader: videoInfo.channel,
      viewCount: videoInfo.view_count,
      uploadDate: videoInfo.upload_date
        ? new Date(videoInfo.upload_date)
        : undefined,
      formats,
    };
  }

  async downloadVideo(
    url: string,
    options?: VideoDownloadOptions,
  ): Promise<string> {
    const videoId = this.getVideoId(url);
    const outputFile =
      options?.outputPath || path.join(this.dataDir, `${videoId}.mp4`);

    // if it already exists, return it
    if (fs.existsSync(outputFile)) {
      return outputFile;
    }

    try {
      const downloadOptions: Record<string, string | boolean> = {
        verbose: true,
        output: outputFile,
        writeInfoJson: true,
      };

      if (options?.format) {
        downloadOptions.format = options.format;
      }
      if (options?.quality) {
        downloadOptions.format = options.quality;
      }
      if (options?.audioOnly) {
        downloadOptions.extractAudio = true;
        downloadOptions.audioFormat = "mp3";
      }
      if (options?.videoOnly) {
        downloadOptions.format = "bestvideo[ext=mp4]/best[ext=mp4]/best";
      }

      await this.binaries.runYtDlp(url, downloadOptions);
      return outputFile;
    } catch (error) {
      elizaLogger.log("Error downloading video:", error);
      throw new Error("Failed to download video");
    }
  }

  async extractAudio(videoPath: string, outputPath?: string): Promise<string> {
    const videoId = this.getVideoId(videoPath);
    const audioFile = outputPath || path.join(this.dataDir, `${videoId}.mp3`);

    if (fs.existsSync(audioFile)) {
      return audioFile;
    }

    await this.configureFfmpeg();
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .output(audioFile)
        .noVideo()
        .audioCodec("libmp3lame")
        .on("end", () => {
          elizaLogger.log("Audio extraction complete");
          resolve(audioFile);
        })
        .on("error", (err) => {
          elizaLogger.log("Error extracting audio:", err);
          reject(err);
        })
        .run();
    });
  }

  async getThumbnail(
    videoPath: string,
    timestamp: number = 1,
  ): Promise<string> {
    const videoId = this.getVideoId(videoPath);
    const thumbnailFile = path.join(this.dataDir, `${videoId}_thumb.jpg`);

    if (fs.existsSync(thumbnailFile)) {
      return thumbnailFile;
    }

    await this.configureFfmpeg();
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .screenshots({
          timestamps: [timestamp],
          filename: `${videoId}_thumb.jpg`,
          folder: this.dataDir,
          size: "320x240",
        })
        .on("end", () => {
          elizaLogger.log("Thumbnail generation complete");
          resolve(thumbnailFile);
        })
        .on("error", (err) => {
          elizaLogger.log("Error generating thumbnail:", err);
          reject(err);
        });
    });
  }

  async convertVideo(
    videoPath: string,
    outputPath: string,
    options?: VideoProcessingOptions,
  ): Promise<string> {
    await this.configureFfmpeg();
    return new Promise((resolve, reject) => {
      let command = ffmpeg(videoPath);

      if (options?.startTime) {
        command = command.seekInput(options.startTime);
      }

      command = command.output(outputPath);

      if (options?.endTime) {
        command = command.duration(options.endTime - (options.startTime || 0));
      }

      if (options?.outputFormat) {
        command = command.format(options.outputFormat);
      }

      if (options?.resolution) {
        command = command.size(options.resolution);
      }

      if (options?.bitrate) {
        command = command.videoBitrate(options.bitrate);
      }

      if (options?.framerate) {
        command = command.fps(options.framerate);
      }

      if (options?.videoCodec) {
        command = command.videoCodec(options.videoCodec);
      }

      if (options?.audioCodec) {
        command = command.audioCodec(options.audioCodec);
      }

      command
        .on("end", () => {
          elizaLogger.log("Video conversion complete");
          resolve(outputPath);
        })
        .on("error", (err) => {
          elizaLogger.log("Error converting video:", err);
          reject(err);
        })
        .run();
    });
  }

  async getAvailableFormats(url: string): Promise<VideoFormat[]> {
    try {
      const result = await this.binaries.runYtDlp(url, {
        dumpJson: true,
        verbose: true,
        callHome: false,
        noCheckCertificates: true,
        preferFreeFormats: true,
        youtubeSkipDashManifest: true,
        skipDownload: true,
      });

      if (
        typeof result === "object" &&
        result !== null &&
        "formats" in result
      ) {
        const parsed = result as YtDlpJson;
        if (parsed.formats?.length) {
          return parsed.formats.map((format: YtDlpFormatRow) => ({
            formatId: format.format_id ?? "",
            url: format.url,
            extension: format.ext,
            quality:
              format.quality !== undefined && format.quality !== ""
                ? String(format.quality)
                : "unknown",
            fileSize: format.filesize,
            videoCodec: format.vcodec,
            audioCodec: format.acodec,
            resolution: format.resolution,
            fps: format.fps,
            bitrate: format.tbr,
          }));
        }
      }

      return [];
    } catch (error) {
      elizaLogger.log("Error getting available formats:", error);
      throw new Error("Failed to get available formats");
    }
  }

  private ensureDataDirectoryExists() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir);
    }
  }

  public isVideoUrl(url: string): boolean {
    try {
      const { hostname } = new URL(url);
      return (
        hostname === "youtube.com" ||
        hostname.endsWith(".youtube.com") ||
        hostname === "youtu.be" ||
        hostname === "vimeo.com" ||
        hostname.endsWith(".vimeo.com")
      );
    } catch {
      return false;
    }
  }

  public async downloadMedia(url: string): Promise<string> {
    const videoId = this.getVideoId(url);
    const outputFile = path.join(this.dataDir, `${videoId}.mp4`);

    // if it already exists, return it
    if (fs.existsSync(outputFile)) {
      return outputFile;
    }

    try {
      await this.binaries.runYtDlp(url, {
        verbose: true,
        output: outputFile,
        format: "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        writeInfoJson: true,
      });
      return outputFile;
    } catch (error) {
      elizaLogger.log("Error downloading media:", error);
      throw new Error("Failed to download media");
    }
  }

  public async processVideo(
    url: string,
    runtime: IAgentRuntime,
  ): Promise<Media> {
    const run = this.processingChain.then(() =>
      this.processVideoFromUrl(url, runtime),
    );
    this.processingChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async processVideoFromUrl(
    url: string,
    runtime: IAgentRuntime,
  ): Promise<Media> {
    const videoId =
      url.match(
        /(?:youtu\.be\/|youtube\.com(?:\/embed\/|\/v\/|\/watch\?v=|\/watch\?.+&v=))([^/&?]+)/, // eslint-disable-line
      )?.[1] || "";
    const videoUuid = this.getVideoId(videoId);
    const cacheKey = `${this.cacheKey}/${videoUuid}`;

    const cached = await runtime.getCache<Media>(cacheKey);

    if (cached) {
      elizaLogger.log("Returning cached video file");
      return cached;
    }

    elizaLogger.log("Cache miss, processing video");
    elizaLogger.log("Fetching video info");
    const videoInfo = await this.fetchVideoInfo(url);
    elizaLogger.log("Getting transcript");
    const transcript = await this.getTranscript(url, videoInfo, runtime);

    const result: Media = {
      id: videoUuid,
      url: url,
      title: videoInfo.title,
      source: videoInfo.channel,
      description: videoInfo.description,
      text: transcript,
    };

    await runtime.setCache(cacheKey, result);

    return result;
  }

  private getVideoId(url: string): string {
    return stringToUuid(url);
  }

  async fetchVideoInfo(url: string): Promise<YtDlpJson> {
    if (url.endsWith(".mp4") || url.includes(".mp4?")) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          // If the URL is a direct link to an MP4 file, return a simplified video info object
          return {
            title: path.basename(url),
            description: "",
            channel: "",
          };
        }
      } catch (error) {
        elizaLogger.log("Error downloading MP4 file:", error);
        // Fall back to using youtube-dl if direct download fails
      }
    }

    try {
      const result = await this.binaries.runYtDlp(url, {
        dumpJson: true,
        verbose: true,
        callHome: false,
        noCheckCertificates: true,
        preferFreeFormats: true,
        youtubeSkipDashManifest: true,
        writeSub: true,
        writeAutoSub: true,
        subLang: "en",
        skipDownload: true,
      });
      return result as YtDlpJson;
    } catch (error) {
      elizaLogger.log("Error fetching video info:", error);
      throw new Error("Failed to fetch video information");
    }
  }

  private async getTranscript(
    url: string,
    videoInfo: YtDlpJson,
    runtime: IAgentRuntime,
  ): Promise<string> {
    elizaLogger.log("Getting transcript");
    try {
      // Check for manual subtitles
      if (videoInfo.subtitles && videoInfo.subtitles.en) {
        elizaLogger.log("Manual subtitles found");
        const srtContent = await this.downloadSRT(
          videoInfo.subtitles.en[0].url,
        );
        return this.parseSRT(srtContent);
      }

      // Check for automatic captions
      if (videoInfo.automatic_captions && videoInfo.automatic_captions.en) {
        elizaLogger.log("Automatic captions found");
        const captionUrl = videoInfo.automatic_captions.en[0].url;
        const captionContent = await this.downloadCaption(captionUrl);
        return this.parseCaption(captionContent);
      }

      // Check if it's a music video
      if (videoInfo.categories && videoInfo.categories.includes("Music")) {
        elizaLogger.log("Music video detected, no lyrics available");
        return "No lyrics available.";
      }

      // Fall back to audio transcription
      elizaLogger.log(
        "No subtitles or captions found, falling back to audio transcription",
      );
      return this.transcribeAudio(url, runtime);
    } catch (error) {
      elizaLogger.log("Error in getTranscript:", error);
      throw error;
    }
  }

  private async downloadCaption(url: string): Promise<string> {
    elizaLogger.log("Downloading caption from:", url);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download caption: ${response.statusText}`);
    }
    return await response.text();
  }

  private parseCaption(captionContent: string): string {
    elizaLogger.log("Parsing caption");
    try {
      const jsonContent = JSON.parse(captionContent);
      if (jsonContent.events) {
        return jsonContent.events
          .filter((event) => event.segs)
          .map((event) => event.segs.map((seg) => seg.utf8).join(""))
          .join("")
          .replace("\n", " ");
      } else {
        elizaLogger.log("Unexpected caption format:", jsonContent);
        return "Error: Unable to parse captions";
      }
    } catch (error) {
      elizaLogger.log("Error parsing caption:", error);
      return "Error: Unable to parse captions";
    }
  }

  private parseSRT(srtContent: string): string {
    // Simple SRT parser (replace with a more robust solution if needed)
    return srtContent
      .split("\n\n")
      .map((block) => block.split("\n").slice(2).join(" "))
      .join(" ");
  }

  private async downloadSRT(url: string): Promise<string> {
    elizaLogger.log("downloadSRT");
    const response = await fetch(url);
    return await response.text();
  }

  async transcribeAudio(url: string, runtime: IAgentRuntime): Promise<string> {
    elizaLogger.log("Preparing audio for transcription...");
    const mp4FilePath = path.join(this.dataDir, `${this.getVideoId(url)}.mp4`);

    const mp3FilePath = path.join(this.dataDir, `${this.getVideoId(url)}.mp3`);

    if (!fs.existsSync(mp3FilePath)) {
      if (fs.existsSync(mp4FilePath)) {
        elizaLogger.log("MP4 file found. Converting to MP3...");
        await this.convertMp4ToMp3(mp4FilePath, mp3FilePath);
      } else {
        elizaLogger.log("Downloading audio...");
        await this.downloadAudio(url, mp3FilePath);
      }
    }

    elizaLogger.log(`Audio prepared at ${mp3FilePath}`);

    const audioBuffer = fs.readFileSync(mp3FilePath);
    elizaLogger.log(`Audio file size: ${audioBuffer.length} bytes`);

    elizaLogger.log("Starting transcription...");
    const startTime = Date.now();
    const transcriptionService = runtime.getService<ITranscriptionService>(
      ServiceType.TRANSCRIPTION,
    );

    if (!transcriptionService) {
      throw new Error("Transcription service not found");
    }

    const result = await transcriptionService.transcribeAudio(audioBuffer);
    const transcript = result.text;

    const endTime = Date.now();
    elizaLogger.log(
      `Transcription completed in ${(endTime - startTime) / 1000} seconds`,
    );

    // Don't delete the MP3 file as it might be needed for future use
    return transcript || "Transcription failed";
  }

  private async convertMp4ToMp3(
    inputPath: string,
    outputPath: string,
  ): Promise<void> {
    await this.configureFfmpeg();
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .output(outputPath)
        .noVideo()
        .audioCodec("libmp3lame")
        .on("end", () => {
          elizaLogger.log("Conversion to MP3 complete");
          resolve();
        })
        .on("error", (err) => {
          elizaLogger.log("Error converting to MP3:", err);
          reject(err);
        })
        .run();
    });
  }

  private async downloadAudio(
    url: string,
    outputFile: string,
  ): Promise<string> {
    elizaLogger.log("Downloading audio");
    outputFile =
      outputFile ?? path.join(this.dataDir, `${this.getVideoId(url)}.mp3`);

    try {
      if (url.endsWith(".mp4") || url.includes(".mp4?")) {
        elizaLogger.log(
          "Direct MP4 file detected, downloading and converting to MP3",
        );
        const tempMp4File = path.join(tmpdir(), `${this.getVideoId(url)}.mp4`);
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        fs.writeFileSync(tempMp4File, buffer);

        await this.configureFfmpeg();
        await new Promise<void>((resolve, reject) => {
          ffmpeg(tempMp4File)
            .output(outputFile)
            .noVideo()
            .audioCodec("libmp3lame")
            .on("end", () => {
              fs.unlinkSync(tempMp4File);
              resolve();
            })
            .on("error", (err) => {
              reject(err);
            })
            .run();
        });
      } else {
        elizaLogger.log(
          "YouTube video detected, downloading audio with youtube-dl",
        );
        await this.binaries.runYtDlp(url, {
          verbose: true,
          extractAudio: true,
          audioFormat: "mp3",
          output: outputFile,
          writeInfoJson: true,
        });
      }
      return outputFile;
    } catch (error) {
      elizaLogger.log("Error downloading audio:", error);
      throw new Error("Failed to download audio");
    }
  }
}
