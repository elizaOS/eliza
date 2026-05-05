import { type IAgentRuntime, logger } from "@elizaos/core";
import type {
  AlbumInfo,
  ArtistInfo,
  MusicInfoResult,
  TrackInfo,
} from "../types";
import { GeniusClient } from "./geniusClient";
import { LastFmClient } from "./lastFmClient";
import { MusicBrainzClient } from "./musicBrainzClient";
import type { MusicInfoServiceStatus, ServiceStatus } from "./serviceStatus";
import { TheAudioDbClient } from "./theAudioDbClient";
import type { WikipediaClient } from "./wikipediaClient";

const MUSIC_INFO_SERVICE_NAME = "musicInfo";

/**
 * Service for fetching music information from authoritative sources.
 * Track metadata comes from YouTube for direct URLs and MusicBrainz for
 * text queries; artist and album metadata comes from MusicBrainz only.
 */
export class MusicInfoHelper {
  capabilityDescription =
    "Fetches music metadata (tracks, artists, albums) from authoritative sources";

  private cache: Map<string, { data: MusicInfoResult; timestamp: number }> =
    new Map();
  private readonly CACHE_TTL = 3600000; // 1 hour in milliseconds
  private musicBrainzClient: MusicBrainzClient | null = null;
  private lastFmClient: LastFmClient | null = null;
  private geniusClient: GeniusClient | null = null;
  private theAudioDbClient: TheAudioDbClient | null = null;
  private readonly wikipediaClient: WikipediaClient | null;
  private serviceStatus: MusicInfoServiceStatus = {
    musicBrainz: { status: "not_configured" as ServiceStatus, lastChecked: 0 },
    lastFm: { status: "not_configured" as ServiceStatus, lastChecked: 0 },
    genius: { status: "not_configured" as ServiceStatus, lastChecked: 0 },
    theAudioDb: { status: "not_configured" as ServiceStatus, lastChecked: 0 },
    wikipedia: { status: "not_configured" as ServiceStatus, lastChecked: 0 },
  };

  constructor(
    runtime?: IAgentRuntime,
    wikipediaClient?: WikipediaClient | null,
  ) {
    this.wikipediaClient = wikipediaClient ?? null;

    // Initialize MusicBrainz (free, no API key needed)
    const userAgent =
      (runtime?.getSetting("MUSICBRAINZ_USER_AGENT") as string) ||
      "ElizaOS-MusicInfo/1.0.0 (https://github.com/elizaos/eliza)";
    this.musicBrainzClient = new MusicBrainzClient(userAgent);
    this.serviceStatus.musicBrainz = {
      status: "active" as ServiceStatus,
      lastChecked: Date.now(),
    };

    // Initialize Last.fm if API key is provided
    const lastFmApiKey = runtime?.getSetting("LASTFM_API_KEY") as string;
    if (lastFmApiKey) {
      try {
        this.lastFmClient = new LastFmClient(lastFmApiKey);
        this.serviceStatus.lastFm = {
          status: "active" as ServiceStatus,
          lastChecked: Date.now(),
        };
      } catch (error) {
        logger.warn(`Last.fm client not initialized: ${error}`);
        this.serviceStatus.lastFm = {
          status: "unavailable" as ServiceStatus,
          lastChecked: Date.now(),
          lastError: String(error),
        };
      }
    }

    // Initialize Genius if API key is provided
    const geniusApiKey = runtime?.getSetting("GENIUS_API_KEY") as string;
    if (geniusApiKey) {
      try {
        this.geniusClient = new GeniusClient(geniusApiKey);
        this.serviceStatus.genius = {
          status: "active" as ServiceStatus,
          lastChecked: Date.now(),
        };
      } catch (error) {
        logger.warn(`Genius client not initialized: ${error}`);
        this.serviceStatus.genius = {
          status: "unavailable" as ServiceStatus,
          lastChecked: Date.now(),
          lastError: String(error),
        };
      }
    }

    // Initialize TheAudioDB if API key is provided
    const theAudioDbApiKey = runtime?.getSetting(
      "THEAUDIODB_API_KEY",
    ) as string;
    if (theAudioDbApiKey) {
      try {
        this.theAudioDbClient = new TheAudioDbClient(theAudioDbApiKey);
        this.serviceStatus.theAudioDb = {
          status: "active" as ServiceStatus,
          lastChecked: Date.now(),
        };
      } catch (error) {
        logger.warn(`TheAudioDB client not initialized: ${error}`);
        this.serviceStatus.theAudioDb = {
          status: "unavailable" as ServiceStatus,
          lastChecked: Date.now(),
          lastError: String(error),
        };
      }
    }

    // Check Wikipedia service availability
    if (this.wikipediaClient) {
      this.serviceStatus.wikipedia = {
        status: "active" as ServiceStatus,
        lastChecked: Date.now(),
      };
    }

    // Validate API keys asynchronously (don't block initialization)
    this.validateApiKeys().catch((error) => {
      logger.debug(`API key validation completed with some issues: ${error}`);
    });
  }

  async stop(): Promise<void> {
    this.clearCache();
  }

  /**
   * Get service status for all integrated APIs
   */
  getServiceStatus(): MusicInfoServiceStatus {
    return { ...this.serviceStatus };
  }

  /**
   * Validate API keys for all configured services
   * Updates service status based on validation results
   */
  private async validateApiKeys(): Promise<void> {
    // Validate Last.fm
    if (this.lastFmClient) {
      try {
        const startTime = Date.now();
        // Test with a well-known artist
        const testResult = await this.lastFmClient.getArtistInfo("The Beatles");
        const responseTime = Date.now() - startTime;
        if (testResult) {
          this.serviceStatus.lastFm = {
            status: "active" as ServiceStatus,
            lastChecked: Date.now(),
            responseTime,
          };
        } else {
          this.serviceStatus.lastFm = {
            status: "degraded" as ServiceStatus,
            lastChecked: Date.now(),
            responseTime,
            lastError: "API returned no results",
          };
        }
      } catch (error) {
        this.serviceStatus.lastFm = {
          status: "unavailable" as ServiceStatus,
          lastChecked: Date.now(),
          lastError: String(error),
        };
        logger.warn(`Last.fm API validation failed: ${error}`);
      }
    }

    // Validate Genius
    if (this.geniusClient) {
      try {
        const startTime = Date.now();
        const isValid = await this.geniusClient.validateApiKey();
        const responseTime = Date.now() - startTime;
        this.serviceStatus.genius = {
          status: isValid
            ? ("active" as ServiceStatus)
            : ("unavailable" as ServiceStatus),
          lastChecked: Date.now(),
          responseTime,
          lastError: isValid ? undefined : "Invalid API key",
        };
        if (!isValid) {
          logger.warn("Genius API key validation failed");
        }
      } catch (error) {
        this.serviceStatus.genius = {
          status: "unavailable" as ServiceStatus,
          lastChecked: Date.now(),
          lastError: String(error),
        };
        logger.warn(`Genius API validation failed: ${error}`);
      }
    }

    // Validate TheAudioDB
    if (this.theAudioDbClient) {
      try {
        const startTime = Date.now();
        const isValid = await this.theAudioDbClient.validateApiKey();
        const responseTime = Date.now() - startTime;
        this.serviceStatus.theAudioDb = {
          status: isValid
            ? ("active" as ServiceStatus)
            : ("unavailable" as ServiceStatus),
          lastChecked: Date.now(),
          responseTime,
          lastError: isValid ? undefined : "Invalid API key",
        };
        if (!isValid) {
          logger.warn("TheAudioDB API key validation failed");
        }
      } catch (error) {
        this.serviceStatus.theAudioDb = {
          status: "unavailable" as ServiceStatus,
          lastChecked: Date.now(),
          lastError: String(error),
        };
        logger.warn(`TheAudioDB API validation failed: ${error}`);
      }
    }

    // Validate MusicBrainz (always available, but test connectivity)
    if (this.musicBrainzClient) {
      try {
        const startTime = Date.now();
        await this.musicBrainzClient.searchRecording("Test", "Test");
        const responseTime = Date.now() - startTime;
        this.serviceStatus.musicBrainz = {
          status: "active" as ServiceStatus,
          lastChecked: Date.now(),
          responseTime,
        };
      } catch (error) {
        this.serviceStatus.musicBrainz = {
          status: "degraded" as ServiceStatus,
          lastChecked: Date.now(),
          lastError: String(error),
        };
        logger.warn(`MusicBrainz connectivity check failed: ${error}`);
      }
    }

    // Validate Wikipedia
    if (this.wikipediaClient) {
      try {
        const startTime = Date.now();
        const testResult =
          await this.wikipediaClient.getArtistInfo("The Beatles");
        const responseTime = Date.now() - startTime;
        this.serviceStatus.wikipedia = {
          status: testResult
            ? ("active" as ServiceStatus)
            : ("degraded" as ServiceStatus),
          lastChecked: Date.now(),
          responseTime,
        };
      } catch (error) {
        this.serviceStatus.wikipedia = {
          status: "degraded" as ServiceStatus,
          lastChecked: Date.now(),
          lastError: String(error),
        };
        logger.warn(`Wikipedia service check failed: ${error}`);
      }
    }
  }

  /**
   * Extract track information from a YouTube URL or MusicBrainz lookup.
   */
  async getTrackInfo(urlOrTitle: string): Promise<MusicInfoResult | null> {
    const cacheKey = `track:${urlOrTitle}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    try {
      if (this.isYouTubeUrl(urlOrTitle)) {
        const info = await this.getInfoFromYouTube(urlOrTitle);
        if (info?.track) {
          const result: MusicInfoResult = {
            track: info.track,
            source: info.source,
          };
          this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
          return result;
        }
        return null;
      }

      const parsed = this.parseTitle(urlOrTitle);
      if (!parsed.title) {
        throw new Error(`Track title is required for lookup: ${urlOrTitle}`);
      }

      if (!this.musicBrainzClient) {
        throw new Error("MusicBrainz client is unavailable");
      }

      const mbTrack = await this.musicBrainzClient.searchRecording(
        parsed.title,
        parsed.artist,
      );
      if (!mbTrack) {
        return null;
      }

      const result: MusicInfoResult = {
        track: mbTrack,
        source: "musicbrainz",
      };
      this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    } catch (error) {
      logger.error(`Error fetching track info for ${urlOrTitle}: ${error}`);
      throw error;
    }
  }

  /**
   * Parse title string to extract artist and track name
   */
  private parseTitle(title: string): { title: string; artist?: string } {
    const patterns = [
      /^(.+?)\s*-\s*(.+)$/, // "Artist - Title"
      /^(.+?)\s+by\s+(.+)$/i, // "Title by Artist"
    ];

    for (const pattern of patterns) {
      const match = title.match(pattern);
      if (match) {
        const [, part1, part2] = match;
        // Determine which is artist and which is title based on pattern
        if (pattern.source.includes("by")) {
          return { title: part1.trim(), artist: part2.trim() };
        } else {
          return { title: part2.trim(), artist: part1.trim() };
        }
      }
    }

    return { title: title.trim() };
  }

  /**
   * Get artist information from MusicBrainz.
   */
  async getArtistInfo(artistName: string): Promise<ArtistInfo | null> {
    const cacheKey = `artist:${artistName}`;
    const cached = this.cache.get(cacheKey);
    if (cached?.data.artist) {
      if (Date.now() - cached.timestamp < this.CACHE_TTL) {
        return cached.data.artist;
      }
    }

    try {
      if (!this.musicBrainzClient) {
        throw new Error("MusicBrainz client is unavailable");
      }

      const mbArtist = await this.musicBrainzClient.getArtist(artistName);
      if (!mbArtist) {
        return null;
      }

      this.cache.set(cacheKey, {
        data: { artist: mbArtist, source: "musicbrainz" },
        timestamp: Date.now(),
      });

      return mbArtist;
    } catch (error) {
      logger.error(`Error fetching artist info for ${artistName}: ${error}`);
      throw error;
    }
  }

  /**
   * Get album information from MusicBrainz.
   */
  async getAlbumInfo(
    albumTitle: string,
    artistName?: string,
  ): Promise<AlbumInfo | null> {
    const cacheKey = `album:${albumTitle}:${artistName || ""}`;
    const cached = this.cache.get(cacheKey);
    if (cached?.data.album) {
      if (Date.now() - cached.timestamp < this.CACHE_TTL) {
        return cached.data.album;
      }
    }

    try {
      if (!this.musicBrainzClient) {
        throw new Error("MusicBrainz client is unavailable");
      }

      const mbAlbum = await this.musicBrainzClient.getRelease(
        albumTitle,
        artistName,
      );
      if (!mbAlbum) {
        return null;
      }

      this.cache.set(cacheKey, {
        data: { album: mbAlbum, source: "musicbrainz" },
        timestamp: Date.now(),
      });

      return mbAlbum;
    } catch (error) {
      logger.error(`Error fetching album info for ${albumTitle}: ${error}`);
      throw error;
    }
  }

  /**
   * Check if a string is a YouTube URL
   */
  private isYouTubeUrl(str: string): boolean {
    const youtubeRegex =
      /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/(watch\?v=|embed\/|v\/)?([a-zA-Z0-9_-]{11})/;
    return youtubeRegex.test(str);
  }

  /**
   * Extract information from YouTube URL using play-dl
   */
  private async getInfoFromYouTube(
    url: string,
  ): Promise<MusicInfoResult | null> {
    try {
      // Dynamic import to avoid bundling issues
      const play = await import("@vookav2/play-dl").then((m) => m.default || m);
      const videoInfo = await play.video_info(url);

      const trackInfo: TrackInfo = {
        title: videoInfo.video_details.title || "Unknown Title",
        artist: videoInfo.video_details.channel?.name || "Unknown Artist",
        duration: videoInfo.video_details.durationInSec || undefined,
        url: url,
        thumbnail: videoInfo.video_details.thumbnails?.[0]?.url || undefined,
        description: videoInfo.video_details.description || undefined,
      };

      return {
        track: trackInfo,
        source: "youtube",
      };
    } catch (error) {
      logger.error(`Error extracting YouTube info: ${error}`);
      throw error;
    }
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Clear expired cache entries
   */
  clearExpiredCache(): void {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp >= this.CACHE_TTL) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Pre-warm cache for a track (non-blocking)
   * This is called by plugin-dj to prepare caches before tracks are played
   * @param urlOrTitle - YouTube URL or track title
   */
  async prewarmTrackInfo(urlOrTitle: string): Promise<void> {
    // Check if already cached
    const cacheKey = `track:${urlOrTitle}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      // Already cached and fresh, no need to pre-warm
      return;
    }

    // Pre-warm asynchronously (fire and forget)
    this.getTrackInfo(urlOrTitle).catch((error) => {
      // Silently log errors - pre-warming is best effort
      logger.debug(`Failed to pre-warm track info for ${urlOrTitle}: ${error}`);
    });
  }

  /**
   * Pre-warm cache for multiple tracks (non-blocking)
   * @param tracks - Array of YouTube URLs or track titles
   */
  async prewarmTracks(tracks: string[]): Promise<void> {
    // Pre-warm all tracks in parallel (non-blocking)
    const promises = tracks.map((track) => this.prewarmTrackInfo(track));
    await Promise.allSettled(promises);
  }
}

export const MUSIC_INFO_HELPER_NAME = MUSIC_INFO_SERVICE_NAME;

export { MusicInfoHelper as MusicInfoService };
