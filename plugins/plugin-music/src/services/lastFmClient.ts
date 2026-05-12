import { logger } from "@elizaos/core";
import type { AlbumInfo, ArtistInfo, TrackInfo } from "../types";
import { type RetryableError, retryWithBackoff } from "../utils/retry";

type LastFmHttpError = Error & RetryableError;

interface LastFmTag {
  name: string;
}

interface LastFmImage {
  size?: string;
  "#text"?: string;
}

interface LastFmNamedEntity {
  name: string;
}

interface LastFmTrackPayload {
  name: string;
  artist?: { name?: string };
  album?: { title?: string };
  duration?: string;
  toptags?: { tag?: LastFmTag[] };
  url?: string;
  wiki?: { content?: string };
}

interface LastFmArtistPayload {
  name: string;
  tags?: { tag?: LastFmTag[] };
  bio?: { content?: string };
  image?: LastFmImage[];
  similar?: { artist?: LastFmNamedEntity[] };
  toptracks?: { track?: LastFmNamedEntity[] };
  albums?: { album?: LastFmNamedEntity[] };
}

interface LastFmAlbumPayload {
  name: string;
  artist?: string;
  wiki?: { published?: string; content?: string };
  tags?: { tag?: LastFmTag[] };
  tracks?: { track?: LastFmNamedEntity[] };
  image?: LastFmImage[];
}

interface LastFmTrackInfoResponse {
  error?: number;
  message?: string;
  track?: LastFmTrackPayload;
}

interface LastFmArtistInfoResponse {
  error?: number;
  message?: string;
  artist?: LastFmArtistPayload;
}

interface LastFmAlbumInfoResponse {
  error?: number;
  message?: string;
  album?: LastFmAlbumPayload;
}

function buildLastFmHttpError(response: Response): LastFmHttpError {
  const error = new Error(
    `Last.fm API error: ${response.status} ${response.statusText}`,
  ) as LastFmHttpError;
  error.response = {
    status: response.status,
    headers: response.headers,
  };
  return error;
}

/**
 * Client for Last.fm API
 * Free tier with API key
 * Rate limit: 5 requests per second
 */
export class LastFmClient {
  private readonly baseUrl = "https://ws.audioscrobbler.com/2.0";
  private readonly apiKey: string;
  private lastRequestTime = 0;
  private readonly minRequestInterval = 200; // 200ms = 5 requests per second

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("Last.fm API key is required");
    }
    this.apiKey = apiKey;
  }

  /**
   * Rate limit: ensure we don't exceed 5 requests per second
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
   * Get track information
   */
  async getTrackInfo(
    trackName: string,
    artistName: string,
  ): Promise<TrackInfo | null> {
    await this.rateLimit();

    return retryWithBackoff(async () => {
      const params = new URLSearchParams({
        method: "track.getInfo",
        api_key: this.apiKey,
        track: trackName,
        artist: artistName,
        format: "json",
      });

      const url = `${this.baseUrl}/?${params.toString()}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw buildLastFmHttpError(response);
      }

      const data = (await response.json()) as LastFmTrackInfoResponse;
      if (data.error) {
        // Don't retry on API errors (invalid key, not found, etc.)
        logger.debug(`Last.fm error: ${data.message}`);
        return null;
      }

      const track = data.track;
      if (!track) {
        return null;
      }

      const trackInfo: TrackInfo = {
        title: track.name,
        artist: track.artist?.name || artistName,
        album: track.album?.title,
        duration: track.duration
          ? Math.floor(parseInt(track.duration, 10) / 1000)
          : undefined,
        tags: track.toptags?.tag?.map((tag) => tag.name) || [],
        url: track.url,
        description: track.wiki?.content
          ? track.wiki.content.substring(0, 500).replace(/<[^>]*>/g, "")
          : undefined,
      };

      return trackInfo;
    }).catch((error) => {
      logger.error(`Error fetching Last.fm track info after retries: ${error}`);
      return null;
    });
  }

  /**
   * Get artist information
   */
  async getArtistInfo(artistName: string): Promise<ArtistInfo | null> {
    await this.rateLimit();

    return retryWithBackoff(async () => {
      const params = new URLSearchParams({
        method: "artist.getInfo",
        api_key: this.apiKey,
        artist: artistName,
        format: "json",
      });

      const url = `${this.baseUrl}/?${params.toString()}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw buildLastFmHttpError(response);
      }

      const data = (await response.json()) as LastFmArtistInfoResponse;
      if (data.error || !data.artist) {
        // Don't retry on API errors (invalid key, not found, etc.)
        return null;
      }

      const artist = data.artist;
      const artistInfo: ArtistInfo = {
        name: artist.name,
        genres: artist.tags?.tag?.map((tag) => tag.name) || [],
        bio: artist.bio?.content
          ? artist.bio.content.substring(0, 1000).replace(/<[^>]*>/g, "")
          : undefined,
        image: artist.image?.find((img) => img.size === "large")?.["#text"],
        similarArtists: artist.similar?.artist?.map((a) => a.name) || [],
        topTracks: artist.toptracks?.track?.map((track) => track.name) || [],
        albums: artist.albums?.album?.map((album) => album.name) || [],
      };

      return artistInfo;
    }).catch((error) => {
      logger.error(
        `Error fetching Last.fm artist info after retries: ${error}`,
      );
      return null;
    });
  }

  /**
   * Get album information
   */
  async getAlbumInfo(
    albumName: string,
    artistName: string,
  ): Promise<AlbumInfo | null> {
    await this.rateLimit();

    return retryWithBackoff(async () => {
      const params = new URLSearchParams({
        method: "album.getInfo",
        api_key: this.apiKey,
        album: albumName,
        artist: artistName,
        format: "json",
      });

      const url = `${this.baseUrl}/?${params.toString()}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw buildLastFmHttpError(response);
      }

      const data = (await response.json()) as LastFmAlbumInfoResponse;
      if (data.error || !data.album) {
        // Don't retry on API errors (invalid key, not found, etc.)
        return null;
      }

      const album = data.album;
      const albumInfo: AlbumInfo = {
        title: album.name,
        artist: album.artist || artistName,
        year: album.wiki?.published
          ? parseInt(album.wiki.published.substring(0, 4), 10)
          : undefined,
        genre: album.tags?.tag?.map((tag) => tag.name) || [],
        tracks: album.tracks?.track?.map((track) => track.name) || [],
        coverArt: album.image?.find((img) => img.size === "large")?.["#text"],
        description: album.wiki?.content
          ? album.wiki.content.substring(0, 500).replace(/<[^>]*>/g, "")
          : undefined,
      };

      return albumInfo;
    }).catch((error) => {
      logger.error(`Error fetching Last.fm album info after retries: ${error}`);
      return null;
    });
  }
}
