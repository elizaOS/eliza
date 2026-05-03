import { type IAgentRuntime, logger, Service, type UUID } from "@elizaos/core";
import {
  type DJAnalytics,
  getAnalytics,
  trackTrackPlayed,
} from "../components/analytics";
import {
  type DJTip,
  type DJTipStats,
  getDJTipStats,
  trackDJTip,
} from "../components/djTips";
import {
  addSongToLibrary,
  getLastPlayedSong,
  getLibraryStats,
  getMostPlayedSongs,
  getRecentSongs,
  getSong,
  type LibrarySong,
  searchLibrary,
} from "../components/musicLibrary";
import {
  deletePlaylist,
  loadPlaylists,
  type Playlist,
  savePlaylist,
} from "../components/playlists";
import {
  getRoomPreferences,
  getUserPreferences,
  trackFavorite,
  trackSkip,
  trackTrackRequest,
  type UserMusicPreferences,
} from "../components/preferences";
import { repetitionControl } from "../components/repetitionControl";
import {
  getSongMemory,
  recordSongDedication,
  recordSongPlay,
  recordSongRequest,
  type SongMemory,
} from "../components/songMemory";
import { SpotifyClient } from "./spotifyClient";

const MUSIC_LIBRARY_SERVICE_NAME = "musicLibrary";

export interface AggregatedRoomPreferences {
  favoriteTracks: Array<{
    url: string;
    title: string;
    requestedBy: UUID[];
    playCount: number;
  }>;
  dislikedTracks: string[];
}

export class MusicLibraryService extends Service {
  static serviceType: string = MUSIC_LIBRARY_SERVICE_NAME;
  capabilityDescription = "Music recommendations based on what you like";

  public readonly spotifyClient: SpotifyClient;
  public readonly repetitionControl = repetitionControl;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    const clientId = runtime?.getSetting("SPOTIFY_CLIENT_ID") as
      | string
      | undefined;
    const clientSecret = runtime?.getSetting("SPOTIFY_CLIENT_SECRET") as
      | string
      | undefined;
    this.spotifyClient = new SpotifyClient(clientId, clientSecret);
  }

  static async start(runtime: IAgentRuntime): Promise<MusicLibraryService> {
    logger.debug(
      `Starting MusicLibraryService for agent ${runtime.character.name}`,
    );
    return new MusicLibraryService(runtime);
  }

  async stop(): Promise<void> {
    // Nothing to clean up yet
  }

  private ensureRuntime(): IAgentRuntime {
    if (!this.runtime) {
      throw new Error("MusicLibraryService runtime is not available");
    }
    return this.runtime;
  }

  // === Library storage ===

  async addSong(
    songData: Parameters<typeof addSongToLibrary>[1],
  ): Promise<LibrarySong> {
    logger.info(
      `[MusicLibraryService] addSong called: "${songData.title}" (${songData.url})`,
    );
    try {
      const result = await addSongToLibrary(this.ensureRuntime(), songData);
      logger.info(
        `[MusicLibraryService] ✅ Song saved: "${result.title}" (${result.playCount} plays)`,
      );
      return result;
    } catch (error) {
      logger.error(`[MusicLibraryService] ❌ Failed to save song: ${error}`);
      throw error;
    }
  }

  async getSong(url: string): Promise<LibrarySong | null> {
    return getSong(this.ensureRuntime(), url);
  }

  async getRecentSongs(limit?: number): Promise<LibrarySong[]> {
    return getRecentSongs(this.ensureRuntime(), limit);
  }

  async getLastPlayedSong(): Promise<LibrarySong | null> {
    return getLastPlayedSong(this.ensureRuntime());
  }

  async getMostPlayedSongs(limit?: number): Promise<LibrarySong[]> {
    return getMostPlayedSongs(this.ensureRuntime(), limit);
  }

  async searchLibrary(query: string, limit?: number): Promise<LibrarySong[]> {
    return searchLibrary(this.ensureRuntime(), query, limit);
  }

  async getLibraryStats(): Promise<{
    totalSongs: number;
    totalPlays: number;
    mostPlayed?: LibrarySong;
  }> {
    return getLibraryStats(this.ensureRuntime());
  }

  // === Playlists ===

  async savePlaylist(
    entityId: UUID,
    playlist: Parameters<typeof savePlaylist>[2],
  ): Promise<Playlist> {
    return savePlaylist(this.ensureRuntime(), entityId, playlist);
  }

  async loadPlaylists(entityId: UUID): Promise<Playlist[]> {
    return loadPlaylists(this.ensureRuntime(), entityId);
  }

  async deletePlaylist(entityId: UUID, playlistId: string): Promise<boolean> {
    return deletePlaylist(this.ensureRuntime(), entityId, playlistId);
  }

  // === Preferences ===

  async getUserPreferences(
    entityId: UUID,
  ): Promise<UserMusicPreferences | null> {
    return getUserPreferences(this.ensureRuntime(), entityId);
  }

  async getRoomPreferences(
    roomId: UUID,
  ): Promise<Map<UUID, UserMusicPreferences>> {
    return getRoomPreferences(this.ensureRuntime(), roomId);
  }

  async getAggregatedRoomPreferences(
    roomId: UUID,
  ): Promise<AggregatedRoomPreferences> {
    try {
      const preferences = await this.getRoomPreferences(roomId);
      const favoriteTrackMap = new Map<
        string,
        {
          url: string;
          title: string;
          requestedBy: Set<UUID>;
          playCount: number;
        }
      >();
      const dislikedTracks = new Set<string>();

      for (const [entityId, prefs] of preferences.entries()) {
        if (prefs.favoriteTracks) {
          for (const track of prefs.favoriteTracks) {
            if (!track.url) continue;
            const existing = favoriteTrackMap.get(track.url);
            if (existing) {
              existing.playCount += track.playCount || 1;
              existing.requestedBy.add(entityId);
            } else {
              favoriteTrackMap.set(track.url, {
                url: track.url,
                title: track.title || "Unknown Title",
                playCount: track.playCount || 1,
                requestedBy: new Set<UUID>([entityId]),
              });
            }
          }
        }

        if (prefs.dislikedTracks) {
          for (const url of prefs.dislikedTracks) {
            dislikedTracks.add(url);
          }
        }
      }

      const favoriteTracks = Array.from(favoriteTrackMap.values())
        .map((entry) => ({
          url: entry.url,
          title: entry.title,
          playCount: entry.playCount,
          requestedBy: Array.from(entry.requestedBy),
        }))
        .sort((a, b) => b.playCount - a.playCount);

      return {
        favoriteTracks,
        dislikedTracks: Array.from(dislikedTracks),
      };
    } catch (error) {
      logger.debug(
        `[MusicLibraryService] Failed to aggregate room preferences: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        favoriteTracks: [],
        dislikedTracks: [],
      };
    }
  }

  async trackTrackRequest(
    entityId: UUID,
    track: { url: string; title: string },
    roomId?: UUID,
    worldId?: UUID,
  ): Promise<void> {
    await trackTrackRequest(
      this.ensureRuntime(),
      entityId,
      track,
      roomId,
      worldId,
    );
  }

  async trackSkip(
    entityId: UUID,
    trackUrl: string,
    roomId?: UUID,
    worldId?: UUID,
  ): Promise<void> {
    await trackSkip(this.ensureRuntime(), entityId, trackUrl, roomId, worldId);
  }

  async trackFavorite(
    entityId: UUID,
    track: { url: string; title: string },
    roomId?: UUID,
    worldId?: UUID,
  ): Promise<void> {
    await trackFavorite(this.ensureRuntime(), entityId, track, roomId, worldId);
  }

  // === Analytics ===

  async trackTrackPlayed(
    roomId: UUID,
    track: { url: string; title: string },
    duration: number,
    requestedBy?: { entityId: UUID; name: string },
  ): Promise<void> {
    await trackTrackPlayed(
      this.ensureRuntime(),
      roomId,
      track,
      duration,
      requestedBy,
    );
  }

  async getAnalytics(roomId: UUID): Promise<DJAnalytics | null> {
    return getAnalytics(this.ensureRuntime(), roomId);
  }

  // === Song memory ===

  async getSongMemory(url: string): Promise<SongMemory | null> {
    return getSongMemory(this.ensureRuntime(), url);
  }

  async recordSongPlay(
    song: Parameters<typeof recordSongPlay>[1],
    context: Parameters<typeof recordSongPlay>[2],
  ): Promise<void> {
    await recordSongPlay(this.ensureRuntime(), song, context);
  }

  async recordSongRequest(
    song: Parameters<typeof recordSongRequest>[1],
    requester: Parameters<typeof recordSongRequest>[2],
  ): Promise<void> {
    await recordSongRequest(this.ensureRuntime(), song, requester);
  }

  async recordSongDedication(
    url: string,
    dedication: Parameters<typeof recordSongDedication>[2],
  ): Promise<void> {
    await recordSongDedication(this.ensureRuntime(), url, dedication);
  }

  // === DJ tips ===

  async trackDJTip(roomId: UUID, tip: Omit<DJTip, "roomId">): Promise<void> {
    await trackDJTip(this.ensureRuntime(), roomId, tip);
  }

  async getDJTipStats(): Promise<DJTipStats> {
    return getDJTipStats(this.ensureRuntime());
  }
}
