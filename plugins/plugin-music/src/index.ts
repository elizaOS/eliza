import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import { musicAction } from "./actions/music";
import { musicInfoProvider } from "./providers/musicInfoProvider";
import musicLibraryProvider from "./providers/musicLibraryProvider";
import musicPlaylistsProvider from "./providers/musicPlaylistsProvider";
import { musicQueueProvider } from "./providers/musicQueueProvider";
import { wikipediaProvider } from "./providers/wikipediaProvider";
import { musicPlayerRoutes } from "./routes";
import { registerMusicLibrarySearchCategories } from "./search-category";
import { MusicService } from "./service";
import { MusicLibraryService } from "./services/musicLibraryService";

export { musicAction } from "./actions/music";
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
export type {
  AudioSubscription,
  BroadcastState,
  BroadcastTrackMetadata,
  IAudioBroadcast,
} from "./contracts";
export { Broadcast } from "./core";
export type { CrossFadeOptions, QueuedTrack } from "./queue";
export {
  type AudioRouteConfig,
  AudioRouter,
  type AudioRoutingMode,
  type MixConfig,
  type MixSession,
  MixSessionManager,
  type Zone,
  ZoneManager,
} from "./router";
export { MusicService } from "./service";
export type { DetectedMusicEntity } from "./services/musicEntityDetectionService";
export {
  MusicEntityDetectionHelper,
  MusicEntityDetectionService,
} from "./services/musicEntityDetectionService";
export { MusicInfoHelper, MusicInfoService } from "./services/musicInfoService";
export { MusicLibraryService } from "./services/musicLibraryService";
export { MusicStorageService, type StoredTrack } from "./services/musicStorage";
export type {
  MusicInfoServiceStatus,
  ServiceHealth,
  ServiceStatus,
} from "./services/serviceStatus";
export type {
  FetchProgress,
  FetchResult,
  SmartFetchOptions,
} from "./services/smartMusicFetch";
export { SmartMusicFetchService } from "./services/smartMusicFetch";
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
export type {
  AlbumInfo,
  ArtistInfo,
  MusicInfoResult,
  TrackInfo,
} from "./types";
export { tryHandleMusicPlayerStatusFallback } from "./route-fallback";
export type {
  AudioFeatureSeed,
  AudioFeatures,
  RecommendationRequest,
  TrackRecommendation,
} from "./types/audioFeatures";

interface DiscordMusicBridgeService {
  clientReadyPromise?: Promise<void> | null;
  voiceManager?: Parameters<MusicService["setVoiceManager"]>[0];
}

const musicPlugin: Plugin = {
  name: "music",
  description:
    "Music library, discovery, playlists, analytics, playback engine, queue, routing API, and streaming routes — unified under the MUSIC action.",
  services: [MusicLibraryService, MusicService],
  actions: [musicAction],
  providers: [
    musicInfoProvider,
    wikipediaProvider,
    musicLibraryProvider,
    musicPlaylistsProvider,
    musicQueueProvider,
  ],
  routes: musicPlayerRoutes,
  autoEnable: {
    envKeys: [
      "LASTFM_API_KEY",
      "GENIUS_API_KEY",
      "THEAUDIODB_API_KEY",
      "SPOTIFY_CLIENT_ID",
      "SPOTIFY_CLIENT_SECRET",
    ],
  },
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    registerMusicLibrarySearchCategories(runtime);
    logger.debug(
      "Music plugin initialized (library + playback); Discord wiring deferred",
    );

    runtime
      .getServiceLoadPromise("discord")
      .then(async (service) => {
        const discordService = service as DiscordMusicBridgeService | null;
        if (!discordService) {
          logger.warn(
            "Discord service not found — music playback runs web-only",
          );
          return;
        }

        if (discordService.clientReadyPromise) {
          logger.debug("Music plugin waiting for Discord client...");
          await discordService.clientReadyPromise;
        }

        runtime
          .getServiceLoadPromise("music")
          .then((svc) => {
            const musicService = svc as MusicService | null;
            if (!musicService) {
              logger.warn("Music service not available after load");
              return;
            }
            const voiceManager = discordService.voiceManager;
            if (voiceManager) {
              musicService.setVoiceManager(voiceManager);
              logger.debug("Music service wired to Discord voice manager");
            } else {
              logger.warn(
                "Discord voice manager unavailable — music playback web-only",
              );
            }
          })
          .catch((error: unknown) => {
            logger.error(`Music service Discord wiring failed: ${error}`);
          });
      })
      .catch((error: unknown) => {
        logger.warn(`Discord unavailable — music playback web-only: ${error}`);
      });
  },
};

export default musicPlugin;
