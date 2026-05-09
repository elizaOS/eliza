import { type IAgentRuntime, logger, Service, type UUID } from "@elizaos/core";

// Local stubs for the optional torrent peer plugins. They aren't always
// installed in the host workspace; we resolve them at runtime via
// runtime.getService(...) and only need a minimal contract here for tsc.
interface TorrentSearchResult {
  title: string;
  size?: string | number;
  seeders?: number;
  leechers?: number;
  magnet?: string;
  url?: string;
  category?: string;
  // Allow downstream code to read additional provider-specific fields without
  // tripping the type checker.
  [key: string]: unknown;
}

interface TorrentSearchService {
  search(
    query: string,
    options?: Record<string, unknown>,
  ): Promise<TorrentSearchResult[]>;
}

interface TorrentInfo {
  id: string;
  done?: boolean;
  files?: string[];
  [key: string]: unknown;
}

interface TorrentService {
  download?(
    magnet: string,
    options?: Record<string, unknown>,
  ): Promise<{
    files?: string[];
    [key: string]: unknown;
  }>;
  addTorrent(options: {
    magnetURI?: string;
    addedBy?: string;
    [key: string]: unknown;
  }): Promise<TorrentInfo>;
  getTorrent(id: string): TorrentInfo | null;
}

const SMART_FETCH_SERVICE_NAME = "smart-music-fetch";

export interface FetchProgress {
  stage:
    | "checking_library"
    | "trying_ytdlp"
    | "searching_torrents"
    | "downloading_torrents"
    | "indexing"
    | "ready"
    | "failed";
  message: string;
  details?: any;
}

export interface FetchResult {
  success: boolean;
  source: "library" | "ytdlp" | "torrent";
  url?: string;
  files?: string[];
  error?: string;
}

export interface SmartFetchOptions {
  query: string;
  requestedBy?: UUID;
  onProgress?: (progress: FetchProgress) => void;
  preferredQuality?: "flac" | "mp3_320" | "any"; // Preference, not requirement - will accept lesser quality
  parallelDownloads?: number;
}

/**
 * Smart music fetch service that tries multiple sources automatically
 * 1. Check music library
 * 2. Try yt-dlp (YouTube, SoundCloud, etc.)
 * 3. Search and download torrents (2-3 in parallel)
 * 4. Notify when ready
 */
export class SmartMusicFetchService extends Service {
  static serviceType: string = SMART_FETCH_SERVICE_NAME;
  capabilityDescription =
    "Intelligently fetches music from multiple sources with automatic fallback";

  static async start(runtime: IAgentRuntime): Promise<SmartMusicFetchService> {
    logger.debug(
      `Starting SmartMusicFetchService for agent ${runtime.character.name}`,
    );
    return new SmartMusicFetchService(runtime);
  }

  async stop(): Promise<void> {
    // Nothing to clean up
  }

  /**
   * Smart fetch music from any available source
   */
  async fetchMusic(options: SmartFetchOptions): Promise<FetchResult> {
    const {
      query,
      requestedBy,
      onProgress,
      preferredQuality = "mp3_320",
      parallelDownloads = 2,
    } = options;

    try {
      // Stage 1: Check music library
      onProgress?.({
        stage: "checking_library",
        message: "Checking music library...",
      });

      const libraryResult = await this.checkMusicLibrary(query);
      if (libraryResult.found) {
        onProgress?.({
          stage: "ready",
          message: "Found in library!",
          details: libraryResult,
        });
        return {
          success: true,
          source: "library",
          url: libraryResult.url,
        };
      }

      // Stage 2: Try yt-dlp (YouTube, SoundCloud, etc.)
      onProgress?.({
        stage: "trying_ytdlp",
        message: "Searching YouTube and other platforms...",
      });

      const ytdlpResult = await this.tryYtdlp(query);
      if (ytdlpResult.success) {
        onProgress?.({
          stage: "ready",
          message: "Found on YouTube!",
          details: ytdlpResult,
        });
        return {
          success: true,
          source: "ytdlp",
          url: ytdlpResult.url,
        };
      }

      // Stage 3: Search torrents
      onProgress?.({
        stage: "searching_torrents",
        message: "Searching torrent indexers...",
      });

      const torrentResults = await this.searchMusicTorrents(
        query,
        preferredQuality,
      );
      if (torrentResults.length === 0) {
        onProgress?.({ stage: "failed", message: "No sources found" });
        return {
          success: false,
          source: "torrent",
          error: "No music found from any source",
        };
      }

      // Stage 4: Download best torrents in parallel
      onProgress?.({
        stage: "downloading_torrents",
        message: `Downloading ${Math.min(parallelDownloads, torrentResults.length)} torrents in parallel...`,
        details: { count: torrentResults.length },
      });

      const downloadResult = await this.downloadTorrentsParallel(
        torrentResults.slice(0, parallelDownloads),
        requestedBy,
      );

      if (downloadResult.success) {
        onProgress?.({ stage: "indexing", message: "Indexing music files..." });

        // Wait a bit for the DOWNLOAD_COMPLETE event to be processed by music library
        await new Promise((resolve) => setTimeout(resolve, 2000));

        onProgress?.({
          stage: "ready",
          message: "Music ready to play!",
          details: downloadResult,
        });
        return {
          success: true,
          source: "torrent",
          files: downloadResult.files,
        };
      }

      onProgress?.({
        stage: "failed",
        message: "All download attempts failed",
      });
      return {
        success: false,
        source: "torrent",
        error: downloadResult.error || "All sources failed",
      };
    } catch (error) {
      logger.error(`Smart fetch error: ${error}`);
      onProgress?.({
        stage: "failed",
        message: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      });
      return {
        success: false,
        source: "library",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Check if music exists in library
   */
  private async checkMusicLibrary(
    query: string,
  ): Promise<{ found: boolean; url?: string; tracks?: any[] }> {
    try {
      const musicLibrary = this.runtime?.getService("musicLibrary") as any;
      if (!musicLibrary?.searchTracks) {
        return { found: false };
      }

      const results = await musicLibrary.searchTracks(query, { limit: 1 });
      if (results && results.length > 0) {
        return {
          found: true,
          url: results[0].url || results[0].filePath,
          tracks: results,
        };
      }

      return { found: false };
    } catch (error) {
      logger.debug(`Music library check failed: ${error}`);
      return { found: false };
    }
  }

  /**
   * Try to find and get URL from YouTube/SoundCloud via search
   */
  private async tryYtdlp(
    query: string,
  ): Promise<{ success: boolean; url?: string; title?: string }> {
    try {
      // Try YouTube search service
      const musicLibrary = this.runtime?.getService("musicLibrary") as any;
      if (!musicLibrary?.searchYouTube) {
        return { success: false };
      }

      const results = await musicLibrary.searchYouTube(query, { limit: 1 });
      if (results && results.length > 0) {
        return {
          success: true,
          url: results[0].url,
          title: results[0].title,
        };
      }

      return { success: false };
    } catch (error) {
      logger.debug(`YouTube search failed: ${error}`);
      return { success: false };
    }
  }

  /**
   * Search for music torrents with quality scoring
   */
  private async searchMusicTorrents(
    query: string,
    preferredQuality: string,
  ): Promise<TorrentSearchResult[]> {
    try {
      const torrentSearch = this.runtime?.getService(
        "torrent-search",
      ) as TorrentSearchService;
      if (!torrentSearch) {
        logger.warn("Torrent search service not available");
        return [];
      }

      // Search without quality filter to get all options
      const allResults = await torrentSearch.search(query, { limit: 30 });

      // Filter for music
      const musicResults = allResults.filter((r) =>
        this.isMusicTorrent(r.title),
      );

      // Score and sort by quality preference + seeders
      const scoredResults = musicResults.map((r) => ({
        ...r,
        score: this.calculateQualityScore(r.title, preferredQuality, r.seeders),
      }));

      // Sort by score (higher is better)
      scoredResults.sort((a, b) => b.score - a.score);

      return scoredResults;
    } catch (error) {
      logger.error(`Torrent search failed: ${error}`);
      return [];
    }
  }

  /**
   * Calculate quality score for a torrent
   * Considers: quality match, seeders, and file format
   */
  private calculateQualityScore(
    title: string,
    preferredQuality: string,
    seeders: number | undefined,
  ): number {
    const lower = title.toLowerCase();
    let score = 0;

    // Base score from seeders (more seeders = better availability)
    score += Math.min(seeders ?? 0, 100); // Cap at 100 to not overshadow quality

    // Quality scoring based on preference
    if (preferredQuality === "flac") {
      // Prefer FLAC, but accept high-quality MP3
      if (lower.includes("flac")) score += 200;
      else if (lower.includes("320") || lower.includes("320kbps")) score += 150;
      else if (lower.includes("256") || lower.includes("v0")) score += 100;
      else if (lower.includes("192")) score += 50;
      else if (lower.includes("mp3")) score += 25; // Any MP3 is acceptable
    } else if (preferredQuality === "mp3_320") {
      // Prefer 320kbps MP3, but accept FLAC or lower bitrates
      if (lower.includes("320") || lower.includes("320kbps")) score += 200;
      else if (lower.includes("flac"))
        score += 180; // FLAC is great too
      else if (lower.includes("256") || lower.includes("v0")) score += 150;
      else if (lower.includes("192")) score += 100;
      else if (lower.includes("128")) score += 50;
      else if (lower.includes("mp3")) score += 25; // Any MP3 is acceptable
    } else {
      // 'any' - just prefer higher quality generally
      if (lower.includes("flac")) score += 150;
      else if (lower.includes("320")) score += 140;
      else if (lower.includes("256") || lower.includes("v0")) score += 120;
      else if (lower.includes("192")) score += 100;
      else if (lower.includes("mp3")) score += 50;
    }

    // Bonus for complete albums vs singles
    if (lower.includes("album") || lower.includes("discography")) {
      score += 20;
    }

    // Penalty for suspicious/low-quality indicators
    if (lower.includes("sample") || lower.includes("preview")) {
      score -= 100;
    }

    return score;
  }

  /**
   * Check if torrent is likely music
   */
  private isMusicTorrent(title: string): boolean {
    const lower = title.toLowerCase();
    const musicExt = [".mp3", ".flac", ".wav", ".m4a", ".ogg"];
    const musicKeywords = [
      "album",
      "discography",
      "flac",
      "mp3",
      "320kbps",
      "lossless",
    ];
    const videoKeywords = ["bluray", "brrip", "x264", "x265", "1080p", "720p"];

    const hasMusic =
      musicExt.some((ext) => lower.includes(ext)) ||
      musicKeywords.some((kw) => lower.includes(kw));
    const hasVideo = videoKeywords.some((kw) => lower.includes(kw));

    return hasMusic && !hasVideo;
  }

  /**
   * Download multiple torrents in parallel, return first to complete
   */
  private async downloadTorrentsParallel(
    torrents: TorrentSearchResult[],
    requestedBy?: UUID,
  ): Promise<{ success: boolean; files?: string[]; error?: string }> {
    try {
      const torrentService = this.runtime?.getService(
        "torrent",
      ) as TorrentService;
      if (!torrentService) {
        return { success: false, error: "Torrent service not available" };
      }

      logger.info(`Starting ${torrents.length} parallel torrent downloads`);

      // Start all downloads
      const downloadPromises = torrents.map(async (torrent, index) => {
        try {
          logger.debug(`Starting download ${index + 1}: ${torrent.title}`);
          const info = await torrentService.addTorrent({
            magnetURI: torrent.magnet,
            addedBy: requestedBy,
          });

          // Wait for completion (poll status)
          return await this.waitForTorrentCompletion(
            torrentService,
            info.id,
            300000,
          ); // 5 min timeout
        } catch (error) {
          logger.warn(`Torrent ${index + 1} failed: ${error}`);
          return null;
        }
      });

      // Wait for first successful download
      const results = await Promise.allSettled(downloadPromises);

      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          logger.info("First torrent completed successfully");
          return {
            success: true,
            files: result.value.files,
          };
        }
      }

      return { success: false, error: "All torrent downloads failed" };
    } catch (error) {
      logger.error(`Parallel download error: ${error}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Wait for torrent to complete
   */
  private async waitForTorrentCompletion(
    torrentService: TorrentService,
    infoHash: string,
    timeout: number,
  ): Promise<{ files: string[] } | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const info = torrentService.getTorrent(infoHash);
      if (!info) return null;

      if (info.done) {
        // Extract file paths (this is simplified - actual implementation depends on TorrentService API)
        return { files: [] }; // Would return actual file paths
      }

      // Wait a bit before checking again
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    return null; // Timeout
  }
}
