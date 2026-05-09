import { exec, execFile } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { logger } from "@elizaos/core";
import {
  augmentEnvWithFfmpegTools,
  resolveFfprobeBinaryPath,
} from "../utils/ffmpegEnv";
import { formatMusicDebugCommand, musicDebug } from "../utils/musicDebug";
import { getYtdlpPath, YTDLP_INSTALL_INSTRUCTIONS } from "../utils/ytdlpCheck";
import { getYtdlpJsRuntimeShellFragment } from "../utils/ytdlpCli";
import {
  getYoutubeExtractorShellFragment,
  shouldRetryYtdlpWithPermissiveFormat,
} from "../utils/ytdlpYoutube";

/**
 * Get YouTube cookies file path from environment or return null
 */
function getYouTubeCookiesPath(): string | null {
  // Check environment variable first
  const cookiesPath = process.env.YOUTUBE_COOKIES || process.env.YTDLP_COOKIES;
  if (cookiesPath && existsSync(cookiesPath)) {
    logger.debug(`Using YouTube cookies file: ${cookiesPath}`);
    return cookiesPath;
  }
  return null;
}

/**
 * Get proxy URL from environment or return null
 * Supports HTTP, HTTPS, and SOCKS proxies
 */
function getProxyUrl(): string | null {
  // Check multiple environment variable names for proxy
  const proxyUrl =
    process.env.YOUTUBE_PROXY ||
    process.env.YTDLP_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.https_proxy;

  if (proxyUrl) {
    // Validate proxy URL format
    try {
      const url = new URL(proxyUrl);
      if (["http:", "https:", "socks4:", "socks5:"].includes(url.protocol)) {
        logger.debug(`Using proxy: ${proxyUrl}`);
        return proxyUrl;
      } else {
        logger.warn(
          `Invalid proxy protocol: ${url.protocol}. Supported: http, https, socks4, socks5`,
        );
      }
    } catch (_error) {
      logger.warn(`Invalid proxy URL format: ${proxyUrl}`);
    }
  }
  return null;
}

/** Matches streaming fallback in ytdlpFallback when strict `-f` has no match. */
const YTDLP_CACHE_PERMISSIVE_FORMAT =
  "bestaudio/best[height<=720]/best[height<=480]/best";

function buildYtdlpCacheDownloadCommand(opts: {
  ytdlpPath: string;
  youtubeUrl: string;
  cacheFilePath: string;
  format: string;
  formatSelector: string;
  proxyUrl: string | null;
  cookiesPath: string | null;
}): string {
  let command = opts.ytdlpPath;
  command += getYtdlpJsRuntimeShellFragment();
  command += getYoutubeExtractorShellFragment(opts.youtubeUrl);
  command += ` -f "${opts.formatSelector}" -x --audio-format ${opts.format}`;
  if (opts.format !== "flac") {
    command += ` --audio-quality 0`;
  }
  command += ` --no-playlist`;
  if (opts.proxyUrl) {
    command += ` --proxy "${opts.proxyUrl}"`;
  }
  if (opts.cookiesPath) {
    command += ` --cookies "${opts.cookiesPath}"`;
  }
  command += ` -o "${opts.cacheFilePath}" "${opts.youtubeUrl}"`;
  return command;
}

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface AudioFileInfo {
  filePath: string;
  size: number;
  duration?: number; // Duration in seconds
  bitrate?: number; // Bitrate in kbps
  format?: string; // Audio format (e.g., 'opus', 'webm')
  sampleRate?: number; // Sample rate in Hz
  channels?: number; // Number of audio channels
}

export interface AudioCacheKey {
  artist?: string;
  album?: string;
  song: string;
  quality: "low" | "medium" | "high" | "highest";
  url: string; // YouTube URL as fallback identifier
}

export interface AudioCacheEntry {
  filePath: string;
  cachedAt: number;
  size: number;
  format: string;
}

/**
 * Audio cache service that downloads, converts, and caches audio files
 *
 * ## Overview
 * This service manages a file-based cache of audio files downloaded from YouTube.
 * Audio is downloaded using yt-dlp and converted to OGG Opus format, which is:
 * - Native to Discord voice (no transcoding needed)
 * - Efficiently compressed (smaller cache size)
 * - High quality (VBR encoding)
 * - Web-compatible (supported by modern browsers)
 *
 * ## Caching Strategy
 * Files are cached based on artist/album/song/quality and stored in the configured
 * cache directory. Each cached file includes metadata (duration, bitrate, etc.)
 * obtained via ffprobe.
 *
 * ## Stream Handling (CRITICAL)
 * ⚠️ This service creates clean, unmodified file streams. DO NOT add event listeners
 * or call resume() on these streams - adding listeners (especially 'readable' and 'data')
 * puts streams into paused mode and prevents Discord.js from controlling stream flow.
 *
 * Let the consumer (Discord.js) handle all stream control, probing, and consumption.
 *
 * @example
 * ```typescript
 * const cache = new AudioCacheService('/path/to/cache');
 * const key = { song: 'Track Name', quality: 'high', url: 'https://...' };
 * const stream = await cache.getAudioStream(key, 'https://youtube.com/...');
 * // Pass stream directly to Discord.js - don't touch it!
 * voiceManager.playAudio(stream, { guildId, channel });
 * ```
 */
export class AudioCacheService {
  private cacheDir: string;
  private readonly CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
  private cacheIndex: Map<string, AudioCacheEntry> = new Map();

  constructor(cacheDir?: string) {
    // Default to ./cache/audio in the project root, or use provided path
    this.cacheDir = cacheDir || join(process.cwd(), "cache", "audio");

    // Ensure cache directory exists
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
      logger.debug(`Created audio cache directory: ${this.cacheDir}`);
    }

    // Load existing cache index
    this.loadCacheIndex();

    // Clean up expired entries on startup
    this.cleanExpiredCache();
  }

  /**
   * Generate cache key from track metadata
   */
  private generateCacheKey(key: AudioCacheKey): string {
    // Sanitize strings for filesystem
    const sanitize = (str: string | undefined): string => {
      if (!str) return "unknown";
      return str
        .replace(/[^a-zA-Z0-9]/g, "_")
        .replace(/_+/g, "_")
        .toLowerCase()
        .substring(0, 100); // Limit length
    };

    const parts = [
      sanitize(key.artist),
      sanitize(key.album),
      sanitize(key.song),
      key.quality,
    ];

    // Normalize URL before hashing to ensure consistent cache keys
    // WHY: Same video can have different URL formats (youtube.com, youtu.be, with/without params)
    const normalizedUrl = this.normalizeUrlForCache(key.url);
    const urlHash = this.hashString(normalizedUrl).substring(0, 8);
    parts.push(urlHash);

    return parts.join("_");
  }

  /**
   * Simple hash function for URLs
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Extract YouTube video ID from various URL formats
   * WHY: YouTube URLs can come in many forms but point to the same video:
   * - https://www.youtube.com/watch?v=ABC123
   * - https://youtube.com/watch?v=ABC123
   * - https://youtu.be/ABC123
   * - https://www.youtube.com/watch?v=ABC123&list=PLxyz&index=1
   *
   * We need to normalize these to get consistent cache keys
   */
  private extractYouTubeVideoId(url: string): string | null {
    try {
      // Handle youtu.be short URLs
      const shortMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
      if (shortMatch) {
        return shortMatch[1];
      }

      // Handle youtube.com/watch?v= URLs
      const watchMatch = url.match(
        /youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/,
      );
      if (watchMatch) {
        return watchMatch[1];
      }

      // Handle youtube.com/embed/ URLs
      const embedMatch = url.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/);
      if (embedMatch) {
        return embedMatch[1];
      }

      // Handle youtube.com/v/ URLs
      const vMatch = url.match(/youtube\.com\/v\/([a-zA-Z0-9_-]{11})/);
      if (vMatch) {
        return vMatch[1];
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Normalize URL for consistent caching
   * WHY: Same video can have different URL formats - we want them to hit the same cache entry
   */
  private normalizeUrlForCache(url: string): string {
    const videoId = this.extractYouTubeVideoId(url);
    if (videoId) {
      // Use canonical YouTube URL format for consistent hashing
      return `youtube:${videoId}`;
    }
    // For non-YouTube URLs, use the full URL
    return url;
  }

  /**
   * Get cache file path for a key
   */
  private getCacheFilePath(key: AudioCacheKey, format?: string): string {
    const cacheKey = this.generateCacheKey(key);
    // Determine file extension based on format
    const audioFormat = (
      format ||
      process.env.AUDIO_CACHE_FORMAT ||
      "opus"
    ).toLowerCase();
    const formatExt =
      audioFormat === "flac"
        ? "flac"
        : audioFormat === "wav"
          ? "wav"
          : audioFormat === "mp3"
            ? "mp3"
            : audioFormat === "m4a"
              ? "m4a"
              : "opus";
    return join(this.cacheDir, `${cacheKey}.${formatExt}`);
  }

  /**
   * Check if audio is cached (checks all supported formats)
   */
  isCached(key: AudioCacheKey): boolean {
    // Check for cached file in any supported format using new normalized URL
    const supportedFormats = ["opus", "flac", "wav", "mp3", "m4a"];
    for (const format of supportedFormats) {
      const filePath = this.getCacheFilePath(key, format);
      const entry = this.cacheIndex.get(filePath);

      if (entry && existsSync(filePath)) {
        // Check if expired
        const age = Date.now() - entry.cachedAt;
        if (age <= this.CACHE_TTL) {
          logger.info(`[CACHE HIT] ${key.song} (${format})`);
          return true;
        }
      }
    }

    // Fallback: Search cache directory for files with matching URL hash
    // WHY: Older cached files may use non-normalized URL hash
    try {
      if (existsSync(this.cacheDir)) {
        const normalizedUrl = this.normalizeUrlForCache(key.url);
        const normalizedUrlHash = this.hashString(normalizedUrl).substring(
          0,
          8,
        );
        const rawUrlHash = this.hashString(key.url).substring(0, 8);

        const files = readdirSync(this.cacheDir);
        const supportedExtensions = [".opus", ".flac", ".wav", ".mp3", ".m4a"];

        // Check for files matching either hash
        for (const file of files) {
          if (!supportedExtensions.some((ext) => file.endsWith(ext))) continue;

          if (file.includes(normalizedUrlHash) || file.includes(rawUrlHash)) {
            const filePath = join(this.cacheDir, file);
            const entry = this.cacheIndex.get(filePath);
            if (entry && existsSync(filePath)) {
              const age = Date.now() - entry.cachedAt;
              if (age <= this.CACHE_TTL) {
                logger.info(
                  `[CACHE HIT] ${key.song} (found by URL hash search)`,
                );
                return true;
              }
            }
          }
        }
      }
    } catch (error) {
      logger.debug(`Error searching cache by URL hash: ${error}`);
    }

    logger.info(`[CACHE MISS] ${key.song}`);
    return false;
  }

  /**
   * Find cached audio by URL (searches all cached files)
   * This is useful when you only have the URL and don't know the exact cache key
   */
  async findCachedAudioByUrl(
    url: string,
    quality: "low" | "medium" | "high" | "highest" = "high",
  ): Promise<Readable | null> {
    // Normalize URL before searching to match cached files
    const normalizedUrl = this.normalizeUrlForCache(url);
    const normalizedUrlHash = this.hashString(normalizedUrl).substring(0, 8);

    // Also calculate the old-format hash (raw URL) for migration/fallback
    // WHY: Existing cached files may use the old non-normalized URL hash
    const rawUrlHash = this.hashString(url).substring(0, 8);

    // Search cache directory for files containing either URL hash
    try {
      if (!existsSync(this.cacheDir)) {
        return null;
      }

      const files = readdirSync(this.cacheDir);
      // Support multiple audio formats when searching by URL
      const supportedExtensions = [".opus", ".flac", ".wav", ".mp3", ".m4a"];

      // Try normalized hash first (new format), then fall back to raw hash (old format)
      let matchingFiles = files.filter(
        (file) =>
          supportedExtensions.some((ext) => file.endsWith(ext)) &&
          file.includes(normalizedUrlHash),
      );

      // Fallback: try old-format hash if normalized didn't find anything
      if (matchingFiles.length === 0 && rawUrlHash !== normalizedUrlHash) {
        logger.debug(
          `[CACHE] No match with normalized hash ${normalizedUrlHash}, trying raw hash ${rawUrlHash}`,
        );
        matchingFiles = files.filter(
          (file) =>
            supportedExtensions.some((ext) => file.endsWith(ext)) &&
            file.includes(rawUrlHash),
        );
        if (matchingFiles.length > 0) {
          logger.debug(`[CACHE] Found match with old-format URL hash`);
        }
      }

      if (matchingFiles.length === 0) {
        logger.info(
          `[CACHE MISS] No cached file found for URL hashes: ${normalizedUrlHash} / ${rawUrlHash}`,
        );
        return null;
      }

      // Try to find a file matching the quality, or use the first match
      let matchedFile: string | null = null;
      for (const file of matchingFiles) {
        if (file.includes(`_${quality}_`) || file.includes(`_${quality}.`)) {
          matchedFile = file;
          break;
        }
      }

      if (!matchedFile && matchingFiles.length > 0) {
        matchedFile = matchingFiles[0];
        logger.debug(
          `Using first matching cached file: ${matchedFile} (quality may not match)`,
        );
      }

      if (matchedFile) {
        const filePath = join(this.cacheDir, matchedFile);
        if (existsSync(filePath)) {
          const stats = statSync(filePath);
          if (stats.size > 0) {
            logger.info(`[CACHE HIT] Found by URL: ${matchedFile}`);

            // Verify file is complete using ffprobe before creating stream
            try {
              const probeInfo = await this.probeAudioFile(filePath);
              if (probeInfo.duration && probeInfo.duration >= 1) {
                const minutes = Math.floor(probeInfo.duration / 60);
                const seconds = Math.floor(probeInfo.duration % 60);
                logger.info(
                  `[CACHE] File duration: ${minutes}:${seconds.toString().padStart(2, "0")} (${probeInfo.duration.toFixed(2)}s)`,
                );
              } else {
                logger.warn(
                  `[CACHE] File appears incomplete (duration: ${probeInfo.duration}s): ${matchedFile}`,
                );
              }
            } catch (probeError) {
              logger.debug(
                `[CACHE] Could not verify file with ffprobe: ${probeError}`,
              );
            }

            // Create stream directly from file (same logic as getCachedAudio)
            const stream = createReadStream(filePath, {
              highWaterMark: 64 * 1024, // 64KB buffer for better streaming
              autoClose: false, // Don't auto-close - let Discord.js control when to close
            });

            // Only add error listener - no 'readable', 'data', 'open', or 'pause' listeners
            // Adding these puts the stream in paused mode and breaks Discord.js stream control
            stream.on("error", (error) => {
              // Only log non-cleanup errors (Premature close might be expected during cleanup)
              const errorMsg = error.message || String(error);
              if (!errorMsg.includes("Premature close") || stream.readable) {
                logger.error(
                  `Cached audio stream error for ${url}: ${errorMsg}`,
                );
              } else {
                logger.debug(
                  `Cached audio stream closed during cleanup for ${url}: ${errorMsg}`,
                );
              }
            });

            // Log when stream ends/closes for debugging (but don't interfere with stream control)
            stream.on("end", () => {
              logger.debug(
                `Cached audio stream ended normally for URL: ${url}`,
              );
            });
            stream.on("close", () => {
              logger.debug(`Cached audio stream closed for URL: ${url}`);
            });

            logger.info(
              `[CACHE] Stream created for URL: ${url}, readable: ${stream.readable}, destroyed: ${stream.destroyed}`,
            );
            return stream;
          }
        }
      }
    } catch (error) {
      logger.debug(`Error searching cache by URL: ${error}`);
    }

    logger.info(`[CACHE MISS] No cached file found for URL: ${url}`);
    return null;
  }

  /**
   * Get cached audio file as a readable stream
   *
   * Returns a clean file stream with NO event listeners attached (except error handling).
   * The stream is in paused mode by default - the consumer must control flow.
   *
   * ⚠️ WARNING: Do not add event listeners or call resume() on the returned stream.
   * Adding listeners puts the stream in paused mode and prevents proper playback.
   * Let Discord.js handle all stream control.
   *
   * @param key - Cache key identifying the audio file
   * @returns Clean readable stream, or null if not cached/invalid
   */
  async getCachedAudio(key: AudioCacheKey): Promise<Readable | null> {
    // Check for cached file in any supported format
    const supportedFormats = ["opus", "flac", "wav", "mp3", "m4a"];
    let filePath: string | null = null;

    // Try to find cached file in any format
    for (const format of supportedFormats) {
      const testPath = this.getCacheFilePath(key, format);
      if (existsSync(testPath)) {
        const entry = this.cacheIndex.get(testPath);
        if (entry) {
          const age = Date.now() - entry.cachedAt;
          if (age <= this.CACHE_TTL) {
            filePath = testPath;
            logger.debug(`Found cached audio in ${format} format: ${filePath}`);
            break;
          }
        }
      }
    }

    if (!filePath) {
      logger.info(`[CACHE MISS] ${key.song} - no cached file found`);
      return null;
    }
    try {
      // Verify file exists and is valid before creating stream
      if (!existsSync(filePath)) {
        logger.info(`[CACHE MISS] ${key.song} - file not found: ${filePath}`);
        return null;
      }

      const stats = statSync(filePath);
      if (stats.size === 0) {
        logger.warn(`[CACHE] Cached file is empty: ${filePath}`);
        return null;
      }

      logger.info(
        `[CACHE HIT] ${key.song} (${(stats.size / 1024 / 1024).toFixed(2)}MB)`,
      );

      // Verify file is complete using ffprobe BEFORE creating stream
      try {
        const probeInfo = await this.probeAudioFile(filePath);
        if (probeInfo.duration && probeInfo.duration >= 1) {
          const minutes = Math.floor(probeInfo.duration / 60);
          const seconds = Math.floor(probeInfo.duration % 60);
          logger.info(
            `[CACHE] File duration: ${minutes}:${seconds.toString().padStart(2, "0")} (${probeInfo.duration.toFixed(2)}s)`,
          );
        } else {
          logger.warn(
            `[CACHE] File appears incomplete (duration: ${probeInfo.duration}s): ${filePath}`,
          );
          // Still return the stream, but log the warning
        }
      } catch (probeError) {
        // ffprobe might not be available, that's okay
        logger.debug(
          `[CACHE] Could not verify cached file with ffprobe: ${probeError}`,
        );
      }

      // Create a clean file stream with optimal buffer size
      // CRITICAL: Do not add event listeners beyond 'error' - they interfere with Discord.js
      const stream = createReadStream(filePath, {
        highWaterMark: 64 * 1024, // 64KB buffer for better streaming
        autoClose: false, // Don't auto-close - let Discord.js control when to close
      });

      // Only add error listener - no 'readable', 'data', 'open', or 'pause' listeners
      // Adding these puts the stream in paused mode and breaks Discord.js stream control
      stream.on("error", (error) => {
        logger.error(
          `Cached audio stream error for ${key.song}: ${error.message}`,
        );
      });

      // Log when stream ends normally (for debugging)
      stream.on("end", () => {
        logger.debug(`Cached audio stream ended normally for: ${key.song}`);
      });

      // Log when stream closes (for debugging)
      stream.on("close", () => {
        logger.debug(`Cached audio stream closed for: ${key.song}`);
      });

      logger.info(
        `[CACHE] Stream created for ${key.song}, readable: ${stream.readable}, destroyed: ${stream.destroyed}`,
      );

      return stream;
    } catch (error) {
      logger.error(`Error reading cached audio: ${error}`);
      return null;
    }
  }

  /**
   * Download and cache audio from YouTube URL
   *
   * Uses yt-dlp to download audio and convert to the configured format.
   * yt-dlp automatically invokes ffmpeg for format conversion.
   *
   * ## Process
   * 1. Check if already cached (skip if so)
   * 2. Download audio using yt-dlp with quality settings
   * 3. Convert to configured format (default: Opus, configurable via AUDIO_CACHE_FORMAT)
   * 4. Probe metadata with ffprobe (duration, bitrate, etc.)
   * 5. Update cache index
   *
   * ## Supported Formats
   * - opus: Discord-optimized, lossy but high quality (default)
   * - flac: Lossless format, prevents additional quality loss from lossy-to-lossy conversions (larger files)
   *   Even though YouTube source is lossy, FLAC preserves the best quality available and prevents
   *   further degradation from multiple lossy conversions (e.g., Opus→Opus or Opus→MP3)
   * - wav: Uncompressed lossless (very large files)
   * - mp3: Lossy, widely compatible
   * - m4a: Lossy, Apple format
   *
   * Set AUDIO_CACHE_FORMAT environment variable to choose format (e.g., export AUDIO_CACHE_FORMAT=flac)
   *
   * Note: Using FLAC prevents quality loss from lossy-to-lossy transcoding, preserving the best
   * quality available from the YouTube source even if the source itself is lossy.
   *
   * ## Quality Mapping
   * - low: worst available audio
   * - medium: up to 128kbps
   * - high: up to 192kbps
   * - highest: best available audio
   *
   * Note: FLAC is lossless, so quality settings don't apply (preserves source quality)
   *
   * @param key - Cache key for the audio
   * @param youtubeUrl - YouTube URL to download from
   * @returns Path to cached file
   * @throws Error if yt-dlp/ffmpeg not installed, download fails, or file invalid
   */
  async downloadAndCache(
    key: AudioCacheKey,
    youtubeUrl: string,
  ): Promise<string> {
    // Check if already cached in any format
    if (this.isCached(key)) {
      // Find the actual cached file path
      const supportedFormats = ["opus", "flac", "wav", "mp3", "m4a"];
      for (const format of supportedFormats) {
        const testPath = this.getCacheFilePath(key, format);
        if (existsSync(testPath)) {
          const entry = this.cacheIndex.get(testPath);
          if (entry) {
            const age = Date.now() - entry.cachedAt;
            if (age <= this.CACHE_TTL) {
              logger.debug(
                `Audio already cached: ${key.song} (${format} format)`,
              );
              return testPath;
            }
          }
        }
      }
    }

    logger.info(`Downloading and caching audio: ${key.song} (${key.quality})`);
    musicDebug("downloadAndCache start", {
      song: key.song,
      quality: key.quality,
      url: youtubeUrl,
    });

    try {
      // Use yt-dlp to download audio directly in the format we want
      // yt-dlp can output to stdout as opus, which we'll pipe to file
      const qualityMap = {
        low: "worstaudio",
        medium: "bestaudio[abr<=128]",
        high: "bestaudio[abr<=192]",
        highest: "bestaudio",
      };

      const qualityArg = qualityMap[key.quality];

      // Verify yt-dlp is available before attempting to use it
      let ytdlpPath: string;
      try {
        ytdlpPath = await getYtdlpPath();
        logger.debug(`Using yt-dlp at: ${ytdlpPath}`);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error(`yt-dlp not available: ${errorMessage}`);
        throw new Error(
          `yt-dlp is required for audio caching but was not found.\n${YTDLP_INSTALL_INSTRUCTIONS}`,
        );
      }

      // Check for YouTube cookies for authentication
      const cookiesPath = getYouTubeCookiesPath();

      // Check for proxy configuration
      const proxyUrl = getProxyUrl();

      // Determine audio format (FLAC for lossless, Opus for Discord-optimized)
      // Check environment variable, default to Opus for Discord compatibility
      const audioFormat = (
        process.env.AUDIO_CACHE_FORMAT || "opus"
      ).toLowerCase();
      const supportedFormats = ["opus", "flac", "wav", "mp3", "m4a"];
      const format = supportedFormats.includes(audioFormat)
        ? audioFormat
        : "opus";

      // Update file path to use correct format extension
      const cacheFilePath = this.getCacheFilePath(key, format);

      logger.debug(
        `Using audio format: ${format} (${format === "flac" ? "lossless - prevents additional quality loss" : "lossy"}) for cache`,
      );

      const formatSelectors = [qualityArg, YTDLP_CACHE_PERMISSIVE_FORMAT];

      for (let attempt = 0; attempt < formatSelectors.length; attempt++) {
        const formatSelector = formatSelectors[attempt]!;
        const command = buildYtdlpCacheDownloadCommand({
          ytdlpPath,
          youtubeUrl,
          cacheFilePath,
          format,
          formatSelector,
          proxyUrl,
          cookiesPath,
        });

        if (proxyUrl) {
          logger.debug(`Using proxy: ${proxyUrl}`);
        }
        if (cookiesPath) {
          logger.debug(`Using cookies file for authentication: ${cookiesPath}`);
        }

        logger.debug(`Executing: ${command}`);
        try {
          const { stderr } = await execAsync(command, {
            maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large outputs
            timeout: 300000, // 5 minute timeout
            env: augmentEnvWithFfmpegTools(),
          });

          if (stderr) {
            const stderrLines = stderr.split("\n");
            const errorLines = stderrLines.filter(
              (line) =>
                line.trim() &&
                !line.includes("WARNING") &&
                !line.includes("Downloading") &&
                !line.includes("Extracting") &&
                !line.includes("[download]") &&
                !line.includes("[info]") &&
                !line.includes("[youtube]") &&
                !line.includes("Destination:") &&
                !line.match(/^\s*\d+\.\d+%/), // Progress percentages
            );

            if (errorLines.length > 0) {
              logger.warn(`yt-dlp warnings/errors: ${errorLines.join("; ")}`);
              musicDebug("cache yt-dlp stderr (filtered lines)", {
                command,
                stderr: errorLines.join("\n"),
              });
            }
          }
          break;
        } catch (execError: unknown) {
          const ee = execError as {
            message?: string;
            code?: string | number;
            stderr?: Buffer | string;
          };
          const stderrStr =
            typeof ee.stderr === "string"
              ? ee.stderr
              : (ee.stderr?.toString?.() ?? "");
          const errorMsg = ee.message || String(execError);
          const errorCode = ee.code;

          if (
            attempt === 0 &&
            shouldRetryYtdlpWithPermissiveFormat(stderrStr, errorMsg)
          ) {
            logger.info(
              `[audioCache] Preferred yt-dlp format unavailable, retrying cache download with permissive format...`,
            );
            continue;
          }

          logger.error(
            `yt-dlp execution failed: ${errorMsg} (code: ${errorCode})`,
          );

          musicDebug("cache yt-dlp exec failed", {
            command,
            formatSelector,
            attempt: attempt + 1,
            error: errorMsg,
            code: errorCode,
            stderr: stderrStr,
          });

          // Do not use errorMsg.includes('yt-dlp') — the command line contains the binary path.
          if (errorCode === "ENOENT") {
            throw new Error(
              `yt-dlp is not installed or not in PATH.\n${YTDLP_INSTALL_INSTRUCTIONS}`,
            );
          }

          const combined = `${stderrStr}\n${errorMsg}`.toLowerCase();
          if (
            combined.includes("sign in") ||
            combined.includes("login") ||
            combined.includes("not a bot")
          ) {
            throw new Error(
              `YouTube authentication required. Set YOUTUBE_COOKIES or YTDLP_COOKIES environment variable to a cookies file.\n` +
                `Export cookies from your browser using extensions like "Get cookies.txt LOCALLY" or "cookies.txt".`,
            );
          }

          if (
            combined.includes("ffmpeg") &&
            (combined.includes("not found") ||
              combined.includes("no such file"))
          ) {
            throw new Error(
              "ffmpeg is required for audio conversion but was not found. " +
                "The music player bundles ffmpeg-static from npm; ensure dependencies are installed.",
            );
          }

          throw new Error(
            `Failed to download/cache audio: ${errorMsg}${stderrStr ? `\n${stderrStr.slice(0, 2000)}` : ""}`,
          );
        }
      }

      // Verify file was created and is valid
      if (!existsSync(cacheFilePath)) {
        throw new Error(`Downloaded file not found at ${cacheFilePath}`);
      }

      const stats = statSync(cacheFilePath);

      // Validate file size
      if (stats.size === 0) {
        throw new Error(`Downloaded file is empty: ${cacheFilePath}`);
      }

      if (stats.size < 1024) {
        logger.warn(
          `Downloaded file is very small (${stats.size} bytes) - might be incomplete: ${cacheFilePath}`,
        );
      }

      // Get detailed file info using ffprobe
      let fileInfo: AudioFileInfo = {
        filePath: cacheFilePath,
        size: stats.size,
      };

      try {
        const probeInfo = await this.probeAudioFile(cacheFilePath);
        fileInfo = { ...fileInfo, ...probeInfo };

        if (fileInfo.duration) {
          const minutes = Math.floor(fileInfo.duration / 60);
          const seconds = Math.floor(fileInfo.duration % 60);
          logger.info(
            `✅ Successfully cached audio: ${key.song}\n` +
              `   File: ${cacheFilePath}\n` +
              `   Format: ${format} (${format === "flac" ? "lossless" : "lossy"})\n` +
              `   Size: ${(stats.size / 1024 / 1024).toFixed(2)}MB (${stats.size.toLocaleString()} bytes)\n` +
              `   Duration: ${minutes}:${seconds.toString().padStart(2, "0")} (${fileInfo.duration.toFixed(2)}s)\n` +
              (fileInfo.bitrate
                ? `   Bitrate: ${fileInfo.bitrate}kbps\n`
                : "") +
              (fileInfo.sampleRate
                ? `   Sample Rate: ${fileInfo.sampleRate}Hz\n`
                : "") +
              (fileInfo.channels ? `   Channels: ${fileInfo.channels}\n` : ""),
          );
        } else {
          logger.info(
            `✅ Successfully cached audio: ${key.song}\n` +
              `   File: ${cacheFilePath}\n` +
              `   Format: ${format} (${format === "flac" ? "lossless" : "lossy"})\n` +
              `   Size: ${(stats.size / 1024 / 1024).toFixed(2)}MB (${stats.size.toLocaleString()} bytes)\n` +
              `   ⚠️  Could not determine duration (metadata missing — file is still on disk; playback/cache return is unaffected).\n` +
              `   Hint: set ELIZA_MUSIC_DEBUG=1 to log ffprobe details.`,
          );
          musicDebug("cache: no duration after probe", {
            path: cacheFilePath,
            size: stats.size,
          });
        }
      } catch (probeError) {
        logger.warn(
          `Could not probe audio file ${cacheFilePath}: ${probeError}`,
        );
        logger.info(
          `✅ Successfully cached audio: ${key.song}\n` +
            `   File: ${cacheFilePath}\n` +
            `   Format: ${format} (${format === "flac" ? "lossless" : "lossy"})\n` +
            `   Size: ${(stats.size / 1024 / 1024).toFixed(2)}MB (${stats.size.toLocaleString()} bytes)\n` +
            `   ⚠️  Could not probe file metadata (ffprobe error — cache file still written; playback pipeline continues).`,
        );
      }

      // Update cache index
      this.cacheIndex.set(cacheFilePath, {
        filePath: cacheFilePath,
        cachedAt: Date.now(),
        size: stats.size,
        format: format,
      });

      return cacheFilePath;
    } catch (error) {
      logger.error(`Error downloading/caching audio: ${error}`);

      // Clean up partial file if it exists (check all possible formats)
      const supportedFormats = ["opus", "flac", "wav", "mp3", "m4a"];
      const audioFormat = (
        process.env.AUDIO_CACHE_FORMAT || "opus"
      ).toLowerCase();
      const format = supportedFormats.includes(audioFormat)
        ? audioFormat
        : "opus";
      const cacheFilePath = this.getCacheFilePath(key, format);

      if (existsSync(cacheFilePath)) {
        try {
          unlinkSync(cacheFilePath);
        } catch (cleanupError) {
          logger.warn(`Error cleaning up partial file: ${cleanupError}`);
        }
      }

      throw error;
    }
  }

  /**
   * Get or download audio (returns file path)
   */
  async getOrDownload(key: AudioCacheKey, youtubeUrl: string): Promise<string> {
    if (this.isCached(key)) {
      return this.getCacheFilePath(key);
    }

    return await this.downloadAndCache(key, youtubeUrl);
  }

  /**
   * Resolve the on-disk file path for a cached track by URL (any quality/format).
   * Returns null when the file has not been cached yet or is expired.
   */
  findCachedFilePathByUrl(url: string): string | null {
    const normalizedUrl = this.normalizeUrlForCache(url);
    const normalizedUrlHash = this.hashString(normalizedUrl).substring(0, 8);
    const rawUrlHash = this.hashString(url).substring(0, 8);

    try {
      if (!existsSync(this.cacheDir)) return null;

      const files = readdirSync(this.cacheDir);
      const exts = [".opus", ".flac", ".wav", ".mp3", ".m4a"];

      let matches = files.filter(
        (f) =>
          exts.some((ext) => f.endsWith(ext)) && f.includes(normalizedUrlHash),
      );
      if (matches.length === 0 && rawUrlHash !== normalizedUrlHash) {
        matches = files.filter(
          (f) => exts.some((ext) => f.endsWith(ext)) && f.includes(rawUrlHash),
        );
      }
      if (matches.length === 0) return null;

      const pick = matches[0]!;
      const p = join(this.cacheDir, pick);
      if (!existsSync(p)) return null;
      const s = statSync(p);
      if (s.size === 0) return null;
      return p;
    } catch {
      return null;
    }
  }

  /**
   * Get cached audio as stream, or download and return stream
   */
  async getAudioStream(
    key: AudioCacheKey,
    youtubeUrl: string,
  ): Promise<Readable> {
    // Try cache first
    const cached = await this.getCachedAudio(key);
    if (cached) {
      logger.debug(`Using cached audio: ${key.song}`);

      // Get file info for logging
      const filePath = this.getCacheFilePath(key);
      try {
        const stats = statSync(filePath);
        const probeInfo = await this.probeAudioFile(filePath);
        if (probeInfo.duration) {
          const minutes = Math.floor(probeInfo.duration / 60);
          const seconds = Math.floor(probeInfo.duration % 60);
          logger.info(
            `📦 Using cached audio: ${key.song}\n` +
              `   File: ${filePath}\n` +
              `   Size: ${(stats.size / 1024 / 1024).toFixed(2)}MB (${stats.size.toLocaleString()} bytes)\n` +
              `   Duration: ${minutes}:${seconds.toString().padStart(2, "0")} (${probeInfo.duration.toFixed(2)}s)`,
          );
        } else {
          logger.info(
            `📦 Using cached audio: ${key.song} (${(stats.size / 1024 / 1024).toFixed(2)}MB)`,
          );
        }
      } catch (infoError) {
        logger.debug(`Could not get cached file info: ${infoError}`);
      }

      // Add logging for cached streams
      cached.on("end", () => {
        logger.debug(`Cached audio stream ended normally for: ${key.song}`);
      });
      cached.on("error", (error) => {
        logger.error(
          `Cached audio stream error for ${key.song}: ${error.message || error}`,
        );
      });
      cached.on("close", () => {
        logger.debug(`Cached audio stream closed for: ${key.song}`);
      });

      // Prevent premature close - don't allow the stream to be destroyed
      // Store original destroy but override to prevent premature closes
      cached.destroy = (error?: Error) => {
        logger.warn(
          `Attempted to destroy cached audio stream for ${key.song}${error ? `: ${error.message}` : ""}`,
        );
        // Don't actually destroy - let it end naturally
        return cached;
      };

      return cached;
    }

    // Download and cache, then return stream
    logger.debug(`Downloading audio: ${key.song}`);
    const filePath = await this.downloadAndCache(key, youtubeUrl);

    // Verify file exists and has reasonable size before streaming
    if (!existsSync(filePath)) {
      throw new Error(`Downloaded file not found at ${filePath}`);
    }

    const stats = statSync(filePath);
    if (stats.size === 0) {
      throw new Error(`Downloaded file is empty: ${filePath}`);
    }

    if (stats.size < 1024) {
      logger.warn(
        `Downloaded file is very small (${stats.size} bytes) - might be incomplete: ${filePath}`,
      );
    }

    // Get file info for logging
    let fileInfo: AudioFileInfo = {
      filePath,
      size: stats.size,
    };

    try {
      const probeInfo = await this.probeAudioFile(filePath);
      fileInfo = { ...fileInfo, ...probeInfo };

      if (fileInfo.duration) {
        const minutes = Math.floor(fileInfo.duration / 60);
        const seconds = Math.floor(fileInfo.duration % 60);
        logger.debug(
          `Creating read stream for cached file:\n` +
            `   File: ${filePath}\n` +
            `   Size: ${(stats.size / 1024 / 1024).toFixed(2)}MB (${stats.size.toLocaleString()} bytes)\n` +
            `   Duration: ${minutes}:${seconds.toString().padStart(2, "0")} (${fileInfo.duration.toFixed(2)}s)\n` +
            `   Format: ${fileInfo.format || "opus"}`,
        );
      } else {
        logger.debug(
          `Creating read stream for cached file: ${filePath} (${(stats.size / 1024 / 1024).toFixed(2)}MB, ${stats.size.toLocaleString()} bytes)`,
        );
      }
    } catch (_probeError) {
      logger.debug(
        `Creating read stream for cached file: ${filePath} (${(stats.size / 1024 / 1024).toFixed(2)}MB, ${stats.size.toLocaleString()} bytes)`,
      );
    }

    const stream = createReadStream(filePath, {
      highWaterMark: 64 * 1024, // 64KB buffer for better streaming
      autoClose: false, // Don't auto-close the file handle
    });

    // CRITICAL: Keep stream CLEAN for Discord.js demuxProbe
    // Event listeners put streams in paused mode, preventing format detection
    // Only add 'error' listener for cleanup
    stream.on("error", (error) => {
      logger.error(
        `Downloaded audio stream error for ${key.song}: ${error.message}`,
      );
    });

    logger.debug(
      `Downloaded audio stream created for ${key.song}, readable: ${stream.readable}, destroyed: ${stream.destroyed}`,
    );

    return stream;
  }

  /**
   * Probe audio file using ffprobe to get metadata
   */
  private async probeAudioFile(
    filePath: string,
  ): Promise<Partial<AudioFileInfo>> {
    const ffprobeBin = resolveFfprobeBinaryPath();
    let fileSize = 0;
    try {
      fileSize = statSync(filePath).size;
    } catch {
      /* best-effort for debug / bitrate fallback */
    }

    musicDebug("probeAudioFile start", {
      filePath,
      ffprobeBin,
      fileSize,
    });

    try {
      const { stdout } = await execFileAsync(
        ffprobeBin,
        [
          "-v",
          "quiet",
          "-print_format",
          "json",
          "-show_format",
          "-show_streams",
          filePath,
        ],
        {
          maxBuffer: 10 * 1024 * 1024,
          timeout: 10000,
          env: augmentEnvWithFfmpegTools(),
        },
      );

      const probeData = JSON.parse(stdout) as {
        format?: {
          duration?: string;
          bit_rate?: string;
          format_name?: string;
        };
        streams?: Array<{
          codec_type?: string;
          duration?: string;
          sample_rate?: string;
          channels?: number;
        }>;
      };
      const info: Partial<AudioFileInfo> = {};

      const audioStream = probeData.streams?.find(
        (s) => s.codec_type === "audio",
      );

      if (probeData.format?.duration) {
        info.duration = parseFloat(probeData.format.duration);
      } else if (audioStream?.duration) {
        info.duration = parseFloat(audioStream.duration);
      }

      if (probeData.format?.format_name) {
        const formatName = probeData.format.format_name.toLowerCase();
        if (formatName.includes("opus")) {
          info.format = "opus";
        } else if (formatName.includes("webm")) {
          info.format = "webm";
        } else if (formatName.includes("ogg")) {
          info.format = "ogg";
        } else {
          info.format = formatName.split(",")[0];
        }
      }

      if (probeData.format?.bit_rate) {
        info.bitrate = Math.round(
          parseInt(probeData.format.bit_rate, 10) / 1000,
        );
      }

      if (audioStream) {
        if (audioStream.sample_rate) {
          info.sampleRate = parseInt(audioStream.sample_rate, 10);
        }
        if (audioStream.channels) {
          info.channels = audioStream.channels;
        }
      }

      const durOk =
        typeof info.duration === "number" &&
        Number.isFinite(info.duration) &&
        info.duration > 0;

      if (!durOk && probeData.format?.bit_rate && fileSize > 0) {
        const br = parseInt(probeData.format.bit_rate, 10);
        if (br > 0) {
          const estimated = (fileSize * 8) / br;
          if (estimated > 0.5 && estimated < 86400) {
            info.duration = estimated;
            musicDebug(
              "probe duration estimated from format bit_rate + file size",
              {
                estimatedSec: estimated,
                bitRate: br,
              },
            );
          }
        }
      }

      musicDebug("probeAudioFile done", {
        duration: info.duration,
        format: info.format,
        bitrateKbps: info.bitrate,
      });

      return info;
    } catch (error: unknown) {
      const err = error as {
        message?: string;
        code?: string;
        stderr?: Buffer | string;
        stdout?: Buffer | string;
      };
      const errorMsg = err.message || String(error);
      const stderrStr =
        err.stderr === undefined
          ? ""
          : typeof err.stderr === "string"
            ? err.stderr
            : err.stderr.toString("utf8");
      const stdoutStr =
        err.stdout === undefined
          ? ""
          : typeof err.stdout === "string"
            ? err.stdout
            : err.stdout.toString("utf8");
      if (errorMsg.includes("ffprobe") || err.code === "ENOENT") {
        logger.debug(`ffprobe not available: ${errorMsg}`);
      } else {
        logger.debug(`ffprobe error for ${filePath}: ${errorMsg}`);
      }
      musicDebug("probeAudioFile error", {
        filePath,
        command: formatMusicDebugCommand(ffprobeBin, [
          "-v",
          "quiet",
          "-print_format",
          "json",
          "-show_format",
          "-show_streams",
          filePath,
        ]),
        error: errorMsg,
        code: err.code,
        stderr: stderrStr,
        stdout: stdoutStr,
      });
      return {};
    }
  }

  /**
   * Load cache index from filesystem
   */
  private loadCacheIndex(): void {
    try {
      // Scan cache directory and build index
      // Support multiple audio formats: opus, flac, wav, mp3, m4a
      const supportedExtensions = [".opus", ".flac", ".wav", ".mp3", ".m4a"];
      const files = readdirSync(this.cacheDir);
      for (const file of files) {
        const hasSupportedExt = supportedExtensions.some((ext) =>
          file.endsWith(ext),
        );
        if (hasSupportedExt) {
          const filePath = join(this.cacheDir, file);
          try {
            const stats = statSync(filePath);
            const format = file.split(".").pop() || "opus";
            this.cacheIndex.set(filePath, {
              filePath,
              cachedAt: stats.mtimeMs,
              size: stats.size,
              format: format,
            });
          } catch (error) {
            logger.warn(`Error reading cache file ${file}: ${error}`);
          }
        }
      }
      logger.debug(`Loaded ${this.cacheIndex.size} cached audio files`);
    } catch (error) {
      logger.warn(`Error loading cache index: ${error}`);
    }
  }

  /**
   * Clean up expired cache entries
   */
  private cleanExpiredCache(): void {
    let cleaned = 0;
    let totalSize = 0;

    for (const [filePath, entry] of this.cacheIndex.entries()) {
      const age = Date.now() - entry.cachedAt;
      if (age > this.CACHE_TTL) {
        try {
          if (existsSync(filePath)) {
            totalSize += entry.size;
            unlinkSync(filePath);
            cleaned++;
          }
          this.cacheIndex.delete(filePath);
        } catch (error) {
          logger.warn(
            `Error deleting expired cache file ${filePath}: ${error}`,
          );
        }
      }
    }

    if (cleaned > 0) {
      logger.info(
        `Cleaned ${cleaned} expired cache files (${(totalSize / 1024 / 1024).toFixed(2)}MB)`,
      );
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    totalFiles: number;
    totalSize: number;
    oldestEntry: number | null;
    newestEntry: number | null;
  } {
    let totalSize = 0;
    let oldestEntry: number | null = null;
    let newestEntry: number | null = null;

    for (const entry of this.cacheIndex.values()) {
      totalSize += entry.size;
      if (!oldestEntry || entry.cachedAt < oldestEntry) {
        oldestEntry = entry.cachedAt;
      }
      if (!newestEntry || entry.cachedAt > newestEntry) {
        newestEntry = entry.cachedAt;
      }
    }

    return {
      totalFiles: this.cacheIndex.size,
      totalSize,
      oldestEntry,
      newestEntry,
    };
  }

  /**
   * Clear all cache
   */
  clearCache(): void {
    let cleared = 0;
    for (const filePath of this.cacheIndex.keys()) {
      try {
        if (existsSync(filePath)) {
          unlinkSync(filePath);
          cleared++;
        }
      } catch (error) {
        logger.warn(`Error deleting cache file ${filePath}: ${error}`);
      }
    }
    this.cacheIndex.clear();
    logger.info(`Cleared ${cleared} cache files`);
  }

  /**
   * Get audio metadata for a cached file (returns undefined if not cached)
   */
  async getAudioMetadata(key: AudioCacheKey): Promise<
    | {
        bitrate?: number;
        format?: string;
        sampleRate?: number;
        channels?: number;
        size?: number;
        duration?: number;
      }
    | undefined
  > {
    const filePath = this.getCacheFilePath(key);
    if (!existsSync(filePath)) {
      return undefined;
    }

    try {
      const stats = statSync(filePath);
      const probeInfo = await this.probeAudioFile(filePath);

      return {
        bitrate: probeInfo.bitrate,
        format: probeInfo.format,
        sampleRate: probeInfo.sampleRate,
        channels: probeInfo.channels,
        size: stats.size,
        duration: probeInfo.duration,
      };
    } catch (error) {
      logger.debug(`Could not get audio metadata: ${error}`);
      return undefined;
    }
  }
}
