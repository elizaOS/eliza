import { logger } from "@elizaos/core";
import type { AlbumInfo, ArtistInfo, TrackInfo } from "../types";
import { retryWithBackoff } from "../utils/retry";

interface MusicBrainzTag {
  name: string;
}

interface MusicBrainzArtistCredit {
  name?: string;
}

interface MusicBrainzRelease {
  title: string;
  date?: string;
  tags?: MusicBrainzTag[];
  "artist-credit"?: MusicBrainzArtistCredit[];
}

interface MusicBrainzRecording {
  title: string;
  length?: number;
  tags?: MusicBrainzTag[];
  releases?: MusicBrainzRelease[];
  "artist-credit"?: MusicBrainzArtistCredit[];
}

interface MusicBrainzArtistAlias {
  name: string;
}

interface MusicBrainzArtist {
  name: string;
  tags?: MusicBrainzTag[];
  aliases?: MusicBrainzArtistAlias[];
}

interface MusicBrainzRecordingResponse {
  recordings?: MusicBrainzRecording[];
}

interface MusicBrainzArtistResponse {
  artists?: MusicBrainzArtist[];
}

interface MusicBrainzReleaseResponse {
  releases?: MusicBrainzRelease[];
}

type MusicBrainzHttpError = Error & {
  response?: {
    status: number;
    statusText: string;
  };
};

function buildMusicBrainzHttpError(response: Response): MusicBrainzHttpError {
  const error = new Error(
    `MusicBrainz API error: ${response.status} ${response.statusText}`,
  ) as MusicBrainzHttpError;
  error.response = {
    status: response.status,
    statusText: response.statusText,
  };
  return error;
}

/**
 * Client for MusicBrainz API
 * Free, no authentication required (just User-Agent header)
 * Rate limit: 1 request per second
 */
export class MusicBrainzClient {
  private readonly baseUrl = "https://musicbrainz.org/ws/2";
  private readonly userAgent: string;
  private lastRequestTime = 0;
  private readonly minRequestInterval = 1000; // 1 second

  constructor(
    userAgent: string = "ElizaOS-MusicInfo/1.0.0 (https://github.com/elizaos/eliza)",
  ) {
    this.userAgent = userAgent;
  }

  /**
   * Rate limit: ensure we wait at least 1 second between requests
   */
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.minRequestInterval) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest),
      );
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * Search for a recording (track) by title and artist
   */
  async searchRecording(
    title: string,
    artist?: string,
  ): Promise<TrackInfo | null> {
    await this.rateLimit();

    return retryWithBackoff(async () => {
      let query = `recording:"${title}"`;
      if (artist) {
        query += ` AND artist:"${artist}"`;
      }

      const url = `${this.baseUrl}/recording?query=${encodeURIComponent(query)}&fmt=json&limit=1`;
      const response = await fetch(url, {
        headers: {
          "User-Agent": this.userAgent,
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw buildMusicBrainzHttpError(response);
      }

      const data = (await response.json()) as MusicBrainzRecordingResponse;
      const recordings = data.recordings ?? [];
      if (recordings.length === 0) {
        return null;
      }

      const recording = recordings[0];
      const trackInfo: TrackInfo = {
        title: recording.title,
        artist:
          recording["artist-credit"]?.[0]?.name || artist || "Unknown Artist",
        duration: recording.length
          ? Math.floor(recording.length / 1000)
          : undefined, // Convert ms to seconds
        tags: recording.tags?.map((tag) => tag.name) || [],
      };

      // Get release (album) info if available
      if (recording.releases && recording.releases.length > 0) {
        const release = recording.releases[0];
        trackInfo.album = release.title;
        if (release.date) {
          trackInfo.year = parseInt(release.date.substring(0, 4), 10);
        }
      }

      return trackInfo;
    }).catch((error) => {
      logger.error(
        `Error fetching MusicBrainz recording after retries: ${error}`,
      );
      throw error;
    });
  }

  /**
   * Get artist information by name
   */
  async getArtist(artistName: string): Promise<ArtistInfo | null> {
    await this.rateLimit();

    return retryWithBackoff(async () => {
      const url = `${this.baseUrl}/artist?query=artist:"${encodeURIComponent(artistName)}"&fmt=json&limit=1`;
      const response = await fetch(url, {
        headers: {
          "User-Agent": this.userAgent,
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw buildMusicBrainzHttpError(response);
      }

      const data = (await response.json()) as MusicBrainzArtistResponse;
      const artists = data.artists ?? [];
      if (artists.length === 0) {
        return null;
      }

      const artist = artists[0];
      const artistInfo: ArtistInfo = {
        name: artist.name,
        genres: artist.tags?.map((tag) => tag.name) || [],
      };

      // Get aliases if available
      if (artist.aliases && artist.aliases.length > 0) {
        artistInfo.similarArtists = artist.aliases.map((alias) => alias.name);
      }

      return artistInfo;
    }).catch((error) => {
      logger.error(`Error fetching MusicBrainz artist after retries: ${error}`);
      throw error;
    });
  }

  /**
   * Get release (album) information
   */
  async getRelease(
    albumTitle: string,
    artistName?: string,
  ): Promise<AlbumInfo | null> {
    await this.rateLimit();

    return retryWithBackoff(async () => {
      let query = `release:"${albumTitle}"`;
      if (artistName) {
        query += ` AND artist:"${artistName}"`;
      }

      const url = `${this.baseUrl}/release?query=${encodeURIComponent(query)}&fmt=json&limit=1`;
      const response = await fetch(url, {
        headers: {
          "User-Agent": this.userAgent,
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw buildMusicBrainzHttpError(response);
      }

      const data = (await response.json()) as MusicBrainzReleaseResponse;
      const releases = data.releases ?? [];
      if (releases.length === 0) {
        return null;
      }

      const release = releases[0];
      const albumInfo: AlbumInfo = {
        title: release.title,
        artist:
          release["artist-credit"]?.[0]?.name || artistName || "Unknown Artist",
        genre: release.tags?.map((tag) => tag.name) || [],
      };

      if (release.date) {
        albumInfo.year = parseInt(release.date.substring(0, 4), 10);
      }

      return albumInfo;
    }).catch((error) => {
      logger.error(
        `Error fetching MusicBrainz release after retries: ${error}`,
      );
      throw error;
    });
  }
}
