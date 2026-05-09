import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import musicLibraryAction from "./actions/musicLibrary";
import { musicInfoProvider } from "./providers/musicInfoProvider";
import musicLibraryProvider from "./providers/musicLibraryProvider";
import musicPlaylistsProvider from "./providers/musicPlaylistsProvider";
import { wikipediaProvider } from "./providers/wikipediaProvider";
import { registerMusicLibrarySearchCategories } from "./search-category";
import { MusicLibraryService } from "./services/musicLibraryService";

export type { DJAnalytics } from "./components/analytics";
export * from "./components/analytics";
export { trackListenerSnapshot } from "./components/analytics";
export * from "./components/djGuildSettings";
export {
  DEFAULT_GUILD_SETTINGS,
  getDJGuildSettings,
  resetDJGuildSettings,
  setAutonomyLevel,
  setDJGuildSettings,
  toggleDJ,
} from "./components/djGuildSettings";
export * from "./components/djIntroOptions";
export {
  buildIntroPrompt,
  DEFAULT_DJ_INTRO_OPTIONS,
  getDJIntroOptions,
  resetDJIntroOptions,
  setDJIntroOptions,
} from "./components/djIntroOptions";
export * from "./components/djTips";
export {
  getDJTipStats,
  getRecentTips,
  getTopTippers,
  trackDJTip,
} from "./components/djTips";
export type { LibrarySong } from "./components/musicLibrary";
// Export components
export * from "./components/musicLibrary";
export type { Playlist } from "./components/playlists";
export * from "./components/playlists";
export type { UserMusicPreferences } from "./components/preferences";
export * from "./components/preferences";
export { repetitionControl } from "./components/repetitionControl";
export * from "./components/songMemory";
export {
  getMostRequestedSongs,
  getSongMemory,
  getTopSongs,
  recordSongDedication,
  recordSongPlay,
  recordSongRequest,
} from "./components/songMemory";
export type { DetectedMusicEntity } from "./services/musicEntityDetectionService";
export {
  MusicEntityDetectionHelper,
  MusicEntityDetectionService,
} from "./services/musicEntityDetectionService";
// Export services
export { MusicInfoHelper, MusicInfoService } from "./services/musicInfoService";
export { MusicLibraryService } from "./services/musicLibraryService";
export { MusicStorageService, type StoredTrack } from "./services/musicStorage";
export type {
  MusicInfoServiceStatus,
  ServiceHealth,
  ServiceStatus,
} from "./services/serviceStatus";
export { SpotifyClient } from "./services/spotifyClient";
export { WikipediaClient, WikipediaService } from "./services/wikipediaClient";
export type {
  ExtractedMusicInfo,
  WikipediaExtractionContext,
} from "./services/wikipediaExtractionService";
export {
  WikipediaExtractionHelper,
  WikipediaExtractionService,
} from "./services/wikipediaExtractionService";
export type { YouTubeSearchResult } from "./services/youtubeSearch";
export {
  YouTubeSearchHelper,
  YouTubeSearchService,
} from "./services/youtubeSearch";
// Export types for use by other plugins
export type {
  AlbumInfo,
  ArtistInfo,
  MusicInfoResult,
  TrackInfo,
} from "./types";
export type {
  AudioFeatureSeed,
  AudioFeatures,
  RecommendationRequest,
  TrackRecommendation,
} from "./types/audioFeatures";

const musicLibraryPlugin: Plugin = {
  name: "music-library",
  description:
    "Plugin for music data storage, preferences, analytics, external APIs, smart music downloading, and YouTube functionality",
  services: [MusicLibraryService],
  providers: [
    musicInfoProvider,
    wikipediaProvider,
    musicLibraryProvider,
    musicPlaylistsProvider,
  ],
  actions: [musicLibraryAction],
  // Self-declared auto-enable: activate when any of the music service API
  // keys are present. (Manifest-only auto-enable — see ./auto-enable.ts.)
  autoEnable: {
    envKeys: [
      "LASTFM_API_KEY",
      "GENIUS_API_KEY",
      "THEAUDIODB_API_KEY",
      "SPOTIFY_CLIENT_ID",
      "SPOTIFY_CLIENT_SECRET",
    ],
  },
  init: async (_config: Record<string, string>, _runtime: IAgentRuntime) => {
    registerMusicLibrarySearchCategories(_runtime);
    logger.debug(
      "Music Library plugin initialized with metadata APIs, playlists, analytics, and YouTube search",
    );
  },
};

export default musicLibraryPlugin;
